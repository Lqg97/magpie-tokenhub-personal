import test from "node:test"
import assert from "node:assert/strict"
import { _internal } from "../index.mjs"

test("signTC3 produces deterministic TC3-HMAC-SHA256 header", () => {
  const res = _internal.signTC3({
    secretId: "AKIDtest123",
    secretKey: "SecretKeyTest456",
    payload: '{"ProductType":"personal"}',
    timestamp: 1763308800,
  })
  assert.equal(res.timestamp, 1763308800)
  assert.match(
    res.authorization,
    /^TC3-HMAC-SHA256 Credential=AKIDtest123\/2025-11-16\/tokenhub\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/,
  )
  const again = _internal.signTC3({
    secretId: "AKIDtest123",
    secretKey: "SecretKeyTest456",
    payload: '{"ProductType":"personal"}',
    timestamp: 1763308800,
  })
  assert.equal(res.authorization, again.authorization)
})

test("callTokenHub sends expected headers and classifies Tencent Cloud errors", async (t) => {
  let seenHeaders
  let seenBody
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    assert.equal(url, "https://tokenhub.tencentcloudapi.com/")
    assert.equal(opts.method, "POST")
    seenHeaders = opts.headers
    seenBody = opts.body
    return Response.json({
      Response: {
        RequestId: "req-1",
        Error: { Code: "AuthFailure.SignatureFailure", Message: "bad signature" },
      },
    })
  })
  const cred = _internal.credOf({
    type: "api",
    key: "sk-tp-test",
    metadata: { secretId: "AKIDx", secretKey: "SKy", site: "intl" },
  })
  await assert.rejects(
    _internal.callTokenHub(cred, "DescribeTokenPlanPersonalPackage", { ProductType: "personal" }),
    (err) => err.refused === true && err.code === "AuthFailure.SignatureFailure" && err.requestId === "req-1",
  )
  assert.equal(seenHeaders["X-TC-Action"], "DescribeTokenPlanPersonalPackage")
  assert.equal(seenHeaders["X-TC-Version"], "2026-03-22")
  assert.equal(seenHeaders["X-TC-Region"], "ap-singapore")
  assert.equal(seenBody, '{"ProductType":"personal"}')
})

test("fetchPersonalApiKey resolves key id then secret", async (t) => {
  const actions = []
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    const action = opts.headers["X-TC-Action"]
    actions.push(action)
    if (action === "DescribeTokenPlanPersonalApiKey") {
      return Response.json({ Response: { ApiKeyId: "ak-123", RequestId: "r1" } })
    }
    if (action === "DescribeTokenPlanPersonalApiKeySecret") {
      assert.equal(opts.body, '{"ApiKeyId":"ak-123"}')
      return Response.json({ Response: { ApiKey: "sk-tp-resolved", RequestId: "r2" } })
    }
    assert.fail(`Unexpected action ${action}`)
  })
  const cred = _internal.credOf({
    type: "api",
    metadata: { secretId: "AKIDx", secretKey: "SKy", site: "cn" },
  })
  const res = await _internal.fetchPersonalApiKey(cred)
  assert.deepEqual(actions, ["DescribeTokenPlanPersonalApiKey", "DescribeTokenPlanPersonalApiKeySecret"])
  assert.deepEqual(res, { id: "ak-123", secret: "sk-tp-resolved" })
})
