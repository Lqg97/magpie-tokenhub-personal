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

test("reports both Common and Hy personal plans using CycleCredits, clean bars and text rows", async (t) => {
  mockPackages(t, {
    personal: {
      PackageStatus: "USED_UP",
      PrepayInquiryKey: "sv_lmp_tokenplan_lite",
      TotalUsed: "780",
      TotalCredits: "2340",
      CycleCredits: "780",
      CurrentCycle: 3,
      TotalCycles: 3,
      ExpireTime: "2026-11-23 17:02:59",
      PeriodEndDate: "2026-11-23",
      AutoRenewFlag: 1,
    },
    "personal-hunyuan": {
      PackageStatus: "ACTIVE",
      PrepayInquiryKey: "sv_lmp_tokenplan_hy_standard",
      TotalUsed: "0.01524",
      TotalCredits: "4680",
      CycleCredits: "1560",
      CurrentCycle: 3,
      TotalCycles: 3,
      ExpireTime: "2026-11-28 14:52:59",
      PeriodEndDate: "2026-11-28",
      AutoRenewFlag: 0,
    },
  })

  const u = await (await plugin.server()).auth.usage(fullAuth())
  assert.equal(u.user, "个人主账号")
  assert.equal(u.plan, "通用版 Lite + Hy 版 Standard")
  assert.equal(u.balance, undefined)
  assert.equal(u.signIn, "kept")
  assert.equal(u.windows.length, 4)

  // Progress bar windows (no amount/limit/unit to keep card layout crisp)
  assert.deepEqual(u.windows[0], {
    name: "通用版",
    used: 100,
    resetsAt: "2026-11-23T17:02:59+08:00",
    aside: true,
  })
  assert.deepEqual(u.windows[1], {
    name: "Hy 版",
    used: 0,
    resetsAt: "2026-11-28T14:52:59+08:00",
  })

  // Text detail rows
  assert.deepEqual(u.windows[2], {
    name: "通用版积分",
    display: "780 / 780（已用尽）",
    text: true,
  })
  assert.deepEqual(u.windows[3], {
    name: "Hy 版积分",
    display: "0.02 / 1,560（余 1,559.98）",
    text: true,
  })
})

test("uses PeriodEndDate as resetsAt when CurrentCycle < TotalCycles", async (t) => {
  mockPackages(t, {
    personal: {
      PackageStatus: "ACTIVE",
      PrepayInquiryKey: "lite",
      TotalUsed: "120",
      CycleCredits: "780",
      TotalCredits: "2340",
      CurrentCycle: 1,
      TotalCycles: 3,
      ExpireTime: "2026-11-23 17:02:59",
      PeriodEndDate: "2026-09-23",
    },
    "personal-hunyuan": {
      PackageStatus: "UNPURCHASED",
    },
  })
  const u = await (await plugin.server()).auth.usage(fullAuth())
  assert.equal(u.windows.length, 2)
  assert.equal(u.plan, "通用版 Lite")
  assert.equal(u.windows[0].resetsAt, "2026-09-23T17:02:59+08:00")
  assert.equal(u.windows[0].used, 15.4)
  assert.equal(u.windows[1].display, "120 / 780（余 660）")
})

test("marks EXPIRED series aside when another series is ACTIVE", async (t) => {
  mockPackages(t, {
    personal: {
      PackageStatus: "ACTIVE",
      PrepayInquiryKey: "standard",
      TotalUsed: 100,
      CycleCredits: 1000,
    },
    "personal-hunyuan": {
      PackageStatus: "EXPIRED",
      PrepayInquiryKey: "lite",
      TotalUsed: 500,
      CycleCredits: 500,
    },
  })
  const u = await (await plugin.server()).auth.usage(fullAuth())
  assert.equal(u.windows.length, 4)
  assert.equal(u.windows[0].aside, undefined)
  assert.equal(u.windows[1].aside, true)
  assert.match(u.windows[3].display, /已过期/)
})

test("partial API failure keeps surviving series window", async (t) => {
  mockPackages(t, {
    personal: {
      PackageStatus: "ACTIVE",
      PrepayInquiryKey: "pro",
      TotalUsed: 300,
      CycleCredits: 1000,
    },
    "personal-hunyuan": new Error("network timeout"),
  })
  const u = await (await plugin.server()).auth.usage(fullAuth())
  assert.equal(u.error, undefined)
  assert.equal(u.windows.length, 3)
  assert.equal(u.windows[2].name, "Hy 版状态")
  assert.match(u.windows[2].display, /network timeout/)
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
    personal: { PackageStatus: "ACTIVE", TotalUsed: 0, CycleCredits: 0, TotalCredits: 0 },
    "personal-hunyuan": { PackageStatus: "UNPURCHASED" },
  })
  const u = await (await plugin.server()).auth.usage(fullAuth())
  assert.equal(u.windows[0].used, 0)
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
