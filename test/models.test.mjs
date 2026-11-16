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

test("merges USED_UP Common & ACTIVE Hy models, parses k/M ModelSpec limits, deduplicates and filters offline", async (t) => {
  const seenOffsets = []
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    const action = opts.headers["X-TC-Action"]
    const body = JSON.parse(opts.body)

    if (action === "DescribeTokenPlanPersonalPackage") {
      return Response.json({
        Response: { PackageStatus: body.ProductType === "personal" ? "USED_UP" : "ACTIVE" },
      })
    }
    if (action === "DescribeTokenPlanPersonalModelList") {
      if (body.ProductType === "personal") {
        return Response.json({
          Response: {
            Models: [
              { ModelId: "hy4", DisplayName: "Hy4", Provider: "Tencent" },
              { ModelId: "deepseek-v4.1-flash-1017", DisplayName: "DeepSeek-V4.1-Flash-1017", Provider: "DeepSeek" },
              { ModelId: "kimi-k3", DisplayName: "Kimi K3", Provider: "Moonshot" },
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
              { ModelId: "hy3", DisplayName: "Hy3", Provider: "Tencent" },
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
                DisplayName: "Hy4",
                Status: "online",
                Tags: ["文本生成", "深度思考", "视觉理解"],
                ModelSpec: { ContextLength: "1024k", MaxOutputToken: "64k" },
              },
              {
                ModelId: "deepseek-v4.1-flash-1017",
                DisplayName: "DeepSeek-V4.1-Flash-1017",
                Status: "online",
                Tags: ["文本生成", "视觉理解", "深度思考"],
                ModelSpec: { ContextLength: "1024K", MaxOutputToken: "384k" },
              },
              {
                ModelId: "kimi-k3",
                DisplayName: "Kimi K3",
                Status: "online",
                Tags: ["深度思考", "文本生成", "视觉理解"],
                ModelSpec: { ContextLength: "1M", MaxOutputToken: "1024k" },
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
                ModelId: "hy3",
                DisplayName: "Hy3",
                Status: "online",
                Tags: ["深度思考", "文本生成"],
                ModelSpec: { ContextLength: "256k", MaxOutputToken: "128k" },
              },
              {
                ModelId: "legacy-model",
                DisplayName: "Legacy",
                Status: "offline",
                Tags: [],
                ModelSpec: { ContextLength: "32k", MaxOutputToken: "4k" },
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
  assert.deepEqual(Object.keys(models), ["hy4", "deepseek-v4.1-flash-1017", "kimi-k3", "hy3"])

  assert.equal(models.hy4.name, "Hy4")
  assert.equal(models.hy4.api.url, "https://tokenhub.tencentmaas.com/plan/v3")
  assert.equal(models.hy4.api.npm, "@ai-sdk/openai-compatible")
  assert.deepEqual(models.hy4.limit, { context: 1024000, output: 64000 })
  assert.equal(models.hy4.capabilities.reasoning, true)
  assert.equal(models.hy4.capabilities.input.image, true)
  assert.equal(models.hy4.capabilities.toolcall, true)
  assert.deepEqual(models.hy4.options, { custom: true })
  assert.deepEqual(models.hy4.variants, { high: { reasoningEffort: "high" } })

  assert.deepEqual(models["deepseek-v4.1-flash-1017"].limit, { context: 1024000, output: 384000 })
  assert.equal(models["deepseek-v4.1-flash-1017"].capabilities.reasoning, true)
  assert.equal(models["deepseek-v4.1-flash-1017"].capabilities.input.image, true)

  assert.deepEqual(models["kimi-k3"].limit, { context: 1000000, output: 1024000 })

  assert.deepEqual(models.hy3.limit, { context: 256000, output: 128000 })
  assert.equal(models.hy3.capabilities.reasoning, true)
  assert.equal(models.hy3.capabilities.input.image, false)
})

test("only queries active/owned series when one series is UNPURCHASED", async (t) => {
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
