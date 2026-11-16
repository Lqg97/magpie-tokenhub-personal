import test from "node:test"
import assert from "node:assert/strict"
import plugin from "../index.mjs"

const fullAuth = (overrides = {}) => async () => ({
  type: "api",
  key: "sk-tp-test",
  metadata: {
    secretId: "AKIDtest",
    secretKey: "SecretTest",
    site: "cn",
    series: "auto",
    accountName: "个人主账号",
    ...overrides,
  },
})

function mockPackages(t, byProduct) {
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    assert.equal(opts.headers["X-TC-Action"], "DescribeTokenPlanPersonalPackage")
    const { ProductType } = JSON.parse(opts.body)
    const reply = byProduct[ProductType]
    if (reply instanceof Error) throw reply
    return Response.json({ Response: reply })
  })
}

test("reports both Common and Hy personal plans with credits, resetsAt and balance", async (t) => {
  mockPackages(t, {
    personal: {
      PackageStatus: "ACTIVE",
      PrepayInquiryKey: "tp_personal_pro",
      TotalUsed: 2500,
      TotalCredits: 10000,
      CycleCredits: 10000,
      CurrentCycle: 1,
      TotalCycles: 1,
      ExpireTime: "2026-12-01 00:00:00",
      AutoRenewFlag: 1,
    },
    "personal-hunyuan": {
      PackageStatus: "ACTIVE",
      PrepayInquiryKey: "tp_hy_standard",
      TotalUsed: 800,
      TotalCredits: 4000,
      CycleCredits: 4000,
      CurrentCycle: 1,
      TotalCycles: 1,
      ExpireTime: "2026-12-15 00:00:00",
      AutoRenewFlag: 0,
    },
  })

  const u = await (await plugin.server()).auth.usage(fullAuth())
  assert.equal(u.user, "个人主账号")
  assert.equal(u.plan, "通用版 Pro + Hy 版 Standard")
  assert.equal(u.balance, "通用版余 7,500 · Hy 版余 3,200")
  assert.equal(u.signIn, "kept")
  assert.equal(u.windows.length, 2)

  assert.equal(u.windows[0].name, "通用版积分")
  assert.equal(u.windows[0].used, 25)
  assert.equal(u.windows[0].amount, 2500)
  assert.equal(u.windows[0].limit, 10000)
  assert.equal(u.windows[0].unit, "credits")
  assert.equal(u.windows[0].resetsAt, "2026-12-01T00:00:00+08:00")
  assert.match(u.windows[0].display, /已用 2,500 \/ 10,000 积分/)
  assert.match(u.windows[0].display, /自动续费/)

  assert.equal(u.windows[1].name, "Hy 版积分")
  assert.equal(u.windows[1].used, 20)
  assert.equal(u.windows[1].amount, 800)
  assert.equal(u.windows[1].limit, 4000)
})

test("skips UNPURCHASED series and keeps active one", async (t) => {
  mockPackages(t, {
    personal: {
      PackageStatus: "ACTIVE",
      PrepayInquiryKey: "lite",
      TotalUsed: 120,
      TotalCredits: 1000,
      ExpireTime: "2026-12-01 00:00:00",
    },
    "personal-hunyuan": {
      PackageStatus: "UNPURCHASED",
    },
  })
  const u = await (await plugin.server()).auth.usage(fullAuth())
  assert.equal(u.windows.length, 1)
  assert.equal(u.plan, "通用版 Lite")
  assert.equal(u.balance, "余 880 积分")
})

test("marks EXPIRED series aside when another series is ACTIVE", async (t) => {
  mockPackages(t, {
    personal: {
      PackageStatus: "ACTIVE",
      PrepayInquiryKey: "standard",
      TotalUsed: 100,
      TotalCredits: 1000,
    },
    "personal-hunyuan": {
      PackageStatus: "EXPIRED",
      PrepayInquiryKey: "lite",
      TotalUsed: 500,
      TotalCredits: 500,
    },
  })
  const u = await (await plugin.server()).auth.usage(fullAuth())
  assert.equal(u.windows.length, 2)
  assert.equal(u.windows[0].aside, undefined)
  assert.equal(u.windows[1].aside, true)
  assert.match(u.windows[1].display, /已过期/)
})

test("partial API failure keeps surviving series window", async (t) => {
  mockPackages(t, {
    personal: {
      PackageStatus: "ACTIVE",
      PrepayInquiryKey: "pro",
      TotalUsed: 300,
      TotalCredits: 1000,
    },
    "personal-hunyuan": new Error("network timeout"),
  })
  const u = await (await plugin.server()).auth.usage(fullAuth())
  assert.equal(u.error, undefined)
  assert.equal(u.windows.length, 1)
  assert.match(u.windows[0].display, /Hy 版查询失败：network timeout/)
})

test("both UNPURCHASED returns clear error with console URL", async (t) => {
  mockPackages(t, {
    personal: { PackageStatus: "UNPURCHASED" },
    "personal-hunyuan": { PackageStatus: "UNPURCHASED" },
  })
  const u = await (await plugin.server()).auth.usage(fullAuth())
  assert.match(u.error, /尚未开通个人版 Token Plan/)
  assert.deepEqual(u.windows, [])
  assert.equal(u.signIn, "kept")
})

test("zero credits does not produce NaN or Infinity", async (t) => {
  mockPackages(t, {
    personal: { PackageStatus: "ACTIVE", TotalUsed: 0, TotalCredits: 0 },
    "personal-hunyuan": { PackageStatus: "UNPURCHASED" },
  })
  const u = await (await plugin.server()).auth.usage(fullAuth())
  assert.equal(u.windows[0].used, undefined)
  assert.doesNotMatch(JSON.stringify(u), /NaN|Infinity/)
})

test("missing SecretId/SecretKey makes zero requests and loader uses site chatURL", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("Unexpected request"))
  const server = await plugin.server()
  const u = await server.auth.usage(async () => ({ type: "api", key: "sk-tp-only" }))
  assert.match(u.error, /SecretId/)
  assert.equal(u.signIn, "kept")
  assert.equal(fetch.mock.callCount(), 0)

  const cnLoader = await server.auth.loader(async () => ({ type: "api", key: "sk-tp-only", metadata: { site: "cn" } }))
  assert.deepEqual(cnLoader, { baseURL: "https://tokenhub.tencentmaas.com/plan/v3", apiKey: "sk-tp-only" })

  const intlLoader = await server.auth.loader(async () => ({ type: "api", key: "sk-tp-only", metadata: { site: "intl" } }))
  assert.deepEqual(intlLoader, { baseURL: "https://tokenhub-intl.tencentmaas.com/plan/v3", apiKey: "sk-tp-only" })
})
