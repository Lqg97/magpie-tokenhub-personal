import test from "node:test"
import assert from "node:assert/strict"
import plugin from "../index.mjs"

const auth = {
  type: "api",
  key: "sk-tp-test",
  metadata: {
    secretId: "AKIDtest",
    secretKey: "SecretTest",
    site: "cn",
    series: "auto",
  },
}

test("merges active Common & Hy models, enriches specs/tags, deduplicates and filters offline", async (t) => {
  const seenOffsets = []
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    const action = opts.headers["X-TC-Action"]
    const body = JSON.parse(opts.body)

    if (action === "DescribeTokenPlanPersonalPackage") {
      return Response.json({ Response: { PackageStatus: "ACTIVE" } })
    }
    if (action === "DescribeTokenPlanPersonalModelList") {
      if (body.ProductType === "personal") {
        return Response.json({
          Response: {
            Models: [
              { ModelId: "hy4", DisplayName: "Hy4", Provider: "Tencent" },
              { ModelId: "deepseek-v4.1-flash", DisplayName: "DeepSeek V4.1 Flash", Provider: "DeepSeek" },
              { ModelId: "legacy-model", DisplayName: "Legacy", Provider: "Other" },
            ],
          },
        })
      }
      if (body.ProductType === "personal-hunyuan") {
        return Response.json({
          Response: {
            Models: [
              { ModelId: "hy4", DisplayName: "Hy4", Provider: "Tencent" },
              { ModelId: "hy-vision-2.0", DisplayName: "Hy Vision 2.0", Provider: "Tencent" },
            ],
          },
        })
      }
    }
    if (action === "DescribeModelList") {
      seenOffsets.push(body.Offset)
      if (body.Offset === 0) {
        return Response.json({
          Response: {
            TotalCount: 105,
            ModelSet: [
              {
                ModelId: "hy4",
                DisplayName: "混元 Hy4",
                Status: "online",
                Tags: ["深度思考", "视觉理解"],
                ModelSpec: { ContextLength: 960000, MaxOutputToken: 64000 },
              },
              {
                ModelId: "deepseek-v4.1-flash",
                DisplayName: "DeepSeek-V4.1-Flash",
                Status: "online",
                Tags: ["深度思考"],
                ModelSpec: { ContextLength: 1000000, MaxOutputToken: 128000 },
              },
            ],
          },
        })
      }
      if (body.Offset === 100) {
        return Response.json({
          Response: {
            TotalCount: 105,
            ModelSet: [
              {
                ModelId: "hy-vision-2.0",
                DisplayName: "Hy Vision 2.0",
                Status: "online",
                Tags: ["多模态理解"],
                ModelSpec: { ContextLength: 256000, MaxOutputToken: 32000 },
              },
              {
                ModelId: "legacy-model",
                DisplayName: "Legacy",
                Status: "offline",
                Tags: [],
                ModelSpec: { ContextLength: 32000, MaxOutputToken: 4096 },
              },
            ],
          },
        })
      }
    }
    assert.fail(`Unexpected action: ${action}`)
  })

  const previous = {
    hy4: { options: { custom: true }, variants: { high: { reasoningEffort: "high" } } },
  }
  const models = await (await plugin.server()).provider.models({ models: previous }, { auth })

  assert.deepEqual(seenOffsets, [0, 100])
  assert.deepEqual(Object.keys(models), ["hy4", "deepseek-v4.1-flash", "hy-vision-2.0"])

  assert.equal(models.hy4.name, "混元 Hy4")
  assert.equal(models.hy4.api.url, "https://tokenhub.tencentmaas.com/plan/v3")
  assert.equal(models.hy4.api.npm, "@ai-sdk/openai-compatible")
  assert.deepEqual(models.hy4.limit, { context: 960000, output: 64000 })
  assert.equal(models.hy4.capabilities.reasoning, true)
  assert.equal(models.hy4.capabilities.input.image, true)
  assert.equal(models.hy4.capabilities.toolcall, true)
  assert.deepEqual(models.hy4.options, { custom: true })
  assert.deepEqual(models.hy4.variants, { high: { reasoningEffort: "high" } })

  assert.equal(models["deepseek-v4.1-flash"].capabilities.reasoning, true)
  assert.equal(models["deepseek-v4.1-flash"].capabilities.input.image, false)
  assert.deepEqual(models["deepseek-v4.1-flash"].limit, { context: 1000000, output: 128000 })

  assert.equal(models["hy-vision-2.0"].capabilities.reasoning, false)
  assert.equal(models["hy-vision-2.0"].capabilities.input.image, true)
})

test("only queries active series when one series is UNPURCHASED", async (t) => {
  const modelQueries = []
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    const action = opts.headers["X-TC-Action"]
    const body = JSON.parse(opts.body)
    if (action === "DescribeTokenPlanPersonalPackage") {
      return Response.json({
        Response: { PackageStatus: body.ProductType === "personal-hunyuan" ? "ACTIVE" : "UNPURCHASED" },
      })
    }
    if (action === "DescribeTokenPlanPersonalModelList") {
      modelQueries.push(body.ProductType)
      return Response.json({ Response: { Models: [{ ModelId: "hy4", DisplayName: "Hy4" }] } })
    }
    if (action === "DescribeModelList") {
      return Response.json({ Response: { TotalCount: 0, ModelSet: [] } })
    }
    assert.fail(`Unexpected action: ${action}`)
  })

  const models = await (await plugin.server()).provider.models({ models: {} }, { auth })
  assert.deepEqual(modelQueries, ["personal-hunyuan"])
  assert.deepEqual(Object.keys(models), ["hy4"])
})

test("keeps personal model list when DescribeModelList fails", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    const action = opts.headers["X-TC-Action"]
    if (action === "DescribeTokenPlanPersonalPackage") {
      return Response.json({ Response: { PackageStatus: "ACTIVE" } })
    }
    if (action === "DescribeTokenPlanPersonalModelList") {
      return Response.json({ Response: { Models: [{ ModelId: "hy3", DisplayName: "Hy3" }] } })
    }
    if (action === "DescribeModelList") {
      throw new Error("catalog error")
    }
    assert.fail(`Unexpected action: ${action}`)
  })

  const models = await (await plugin.server()).provider.models({ models: {} }, { auth })
  assert.deepEqual(Object.keys(models), ["hy3"])
  assert.deepEqual(models.hy3.limit, { context: 128000, output: 16384 })
})

test("unauthenticated listing preserves host fallback", async () => {
  const server = await plugin.server()
  const fallback = { hy4: { id: "hy4" } }
  assert.equal(await server.provider.models({ models: fallback }), fallback)
})
