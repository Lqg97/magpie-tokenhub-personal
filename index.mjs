import crypto from "node:crypto"

const PROVIDER = "tencent-token-plan"
const API_HOST = "tokenhub.tencentcloudapi.com"
const API_ENDPOINT = `https://${API_HOST}/`
const API_SERVICE = "tokenhub"
const API_VERSION = "2026-03-22"
const API_TIMEOUT_MS = 15_000
const SIGNIN_TIMEOUT_MS = 10 * 60 * 1000
const SIGNIN_PAGE = new URL("./signin.html", import.meta.url)

const SITES = {
  cn: {
    label: "中国站",
    region: "ap-guangzhou",
    chatURL: "https://tokenhub.tencentmaas.com/plan/v3",
    consoleURL: "https://console.cloud.tencent.com/tokenhub/tokenplan",
    camURL: "https://console.cloud.tencent.com/cam/capi",
  },
  intl: {
    label: "国际站",
    region: "ap-singapore",
    chatURL: "https://tokenhub-intl.tencentmaas.com/plan/v3",
    consoleURL: "https://console.tencentcloud.com/tokenhub/tokenplan",
    camURL: "https://console.cloud.tencent.com/cam/capi",
  },
}

const SERIES = [
  { key: "common", productType: "personal", label: "通用版" },
  { key: "hy", productType: "personal-hunyuan", label: "Hy 版" },
]

const TIER_NAMES = {
  lite: "Lite",
  standard: "Standard",
  pro: "Pro",
  max: "Max",
}

const OWNED_MODEL_STATUSES = new Set(["ACTIVE", "USED_UP"])
const OFFLINE_STATUSES = new Set(["discontinued", "offline", "pre-offline"])

const DEFAULT_MODEL_IDS = [
  "hy4",
  "hy3",
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "glm-5.3",
  "glm-5.3-flash",
  "kimi-k3",
  "minimax-m3",
]

function buildDefaultModels(baseURL) {
  return Object.fromEntries(
    DEFAULT_MODEL_IDS.map((id) => [
      id,
      {
        id,
        providerID: PROVIDER,
        name: id,
        api: { id, url: baseURL, npm: "@ai-sdk/openai-compatible" },
        limit: { context: 128_000, output: 16_384 },
        capabilities: {
          reasoning: true,
          toolcall: true,
          input: { text: true, image: id.startsWith("hy") || id.startsWith("kimi") },
          output: { text: true },
        },
        variants: {},
      },
    ]),
  )
}

function siteOf(raw) {
  return raw === "intl" ? SITES.intl : SITES.cn
}

function seriesListOf(mode) {
  if (mode === "common") return [SERIES[0]]
  if (mode === "hy") return [SERIES[1]]
  return SERIES
}

function credOf(auth) {
  const m = auth?.metadata ?? {}
  const siteKey = m.site === "intl" ? "intl" : "cn"
  const site = siteOf(siteKey)
  return {
    apiKey: String(auth?.key ?? "").trim(),
    secretId: String(m.secretId ?? "").trim(),
    secretKey: String(m.secretKey ?? "").trim(),
    token: String(m.token ?? "").trim(),
    siteKey,
    site,
    seriesMode: m.series === "common" || m.series === "hy" ? m.series : "auto",
    accountName: String(m.accountName ?? m.email ?? "").trim(),
  }
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex")
}

function hmacSha256(key, data, encoding) {
  const mac = crypto.createHmac("sha256", key).update(data)
  return encoding ? mac.digest(encoding) : mac.digest()
}

function signTC3({ secretId, secretKey, payload = "{}", timestamp, service = API_SERVICE, host = API_HOST, contentType = "application/json; charset=utf-8" }) {
  const ts = Number.isFinite(timestamp) ? Math.floor(timestamp) : Math.floor(Date.now() / 1000)
  const date = new Date(ts * 1000).toISOString().slice(0, 10)
  const canonicalHeaders = `content-type:${contentType.toLowerCase()}\nhost:${host.toLowerCase()}\n`
  const signedHeaders = "content-type;host"
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    sha256Hex(payload),
  ].join("\n")

  const credentialScope = `${date}/${service}/tc3_request`
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(ts),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n")

  const secretDate = hmacSha256(`TC3${secretKey}`, date)
  const secretService = hmacSha256(secretDate, service)
  const secretSigning = hmacSha256(secretService, "tc3_request")
  const signature = hmacSha256(secretSigning, stringToSign, "hex")

  return {
    timestamp: ts,
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

async function callTokenHub(cred, action, body = {}, { timestamp } = {}) {
  if (!cred.secretId || !cred.secretKey) {
    throw Object.assign(new Error("未配置腾讯云 SecretId / SecretKey"), { missingCreds: true })
  }
  const payload = JSON.stringify(body ?? {})
  const contentType = "application/json; charset=utf-8"
  const { timestamp: ts, authorization } = signTC3({
    secretId: cred.secretId,
    secretKey: cred.secretKey,
    payload,
    timestamp,
    contentType,
  })
  const headers = {
    "Content-Type": contentType,
    Host: API_HOST,
    Authorization: authorization,
    "X-TC-Action": action,
    "X-TC-Version": API_VERSION,
    "X-TC-Timestamp": String(ts),
    "X-TC-Region": cred.site.region,
  }
  if (cred.token) headers["X-TC-Token"] = cred.token

  const res = await fetch(API_ENDPOINT, {
    method: "POST",
    headers,
    body: payload,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.Response) {
    throw Object.assign(new Error(`TokenHub 接口 ${action} 返回 HTTP ${res.status}`), {
      refused: res.status === 401 || res.status === 403,
      status: res.status,
    })
  }
  if (json.Response.Error) {
    const err = json.Response.Error
    const code = String(err.Code ?? "")
    throw Object.assign(new Error(`${code ? `${code}: ` : ""}${err.Message || action + " 调用失败"}`), {
      code,
      requestId: json.Response.RequestId,
      refused: code.startsWith("AuthFailure."),
      notFound: code.startsWith("ResourceNotFound"),
    })
  }
  return json.Response
}

async function fetchPersonalApiKey(cred) {
  let info
  try {
    info = await callTokenHub(cred, "DescribeTokenPlanPersonalApiKey", {})
  } catch (e) {
    if (e.notFound) {
      throw new Error(`尚未生成个人版共享 API Key，请前往控制台创建：${cred.site.consoleURL}`)
    }
    throw e
  }
  const keyId = info?.ApiKeyId
  if (!keyId) {
    throw new Error(`尚未生成个人版共享 API Key，请前往控制台创建：${cred.site.consoleURL}`)
  }
  const secretRes = await callTokenHub(cred, "DescribeTokenPlanPersonalApiKeySecret", { ApiKeyId: keyId })
  const secret = typeof secretRes?.ApiKey === "string" ? secretRes.ApiKey.trim() : ""
  if (!secret) {
    throw new Error("未能获取到个人版共享 API Key 明文，请手动填写 sk-tp-…")
  }
  return { id: String(keyId), secret }
}

function tierLabel(prepayInquiryKey) {
  const raw = String(prepayInquiryKey ?? "").trim().toLowerCase()
  const tail = raw.split("_").pop() ?? raw
  return TIER_NAMES[tail] ?? (tail ? tail : "")
}

function parseTencentTime(raw) {
  const text = String(raw ?? "").trim()
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(text)
  if (!m) return undefined
  const iso = `${m[1]}T${m[2]}+08:00`
  return Number.isFinite(Date.parse(iso)) ? iso : undefined
}

function cycleResetTime(pkg) {
  const expireIso = parseTencentTime(pkg?.ExpireTime)
  const periodDate = String(pkg?.PeriodEndDate ?? "").trim()
  const current = Number(pkg?.CurrentCycle)
  const total = Number(pkg?.TotalCycles)
  if (/^\d{4}-\d{2}-\d{2}$/.test(periodDate) && Number.isFinite(current) && Number.isFinite(total) && current < total) {
    const timePart = String(pkg?.ExpireTime ?? "").trim().slice(11, 19) || "23:59:59"
    const iso = `${periodDate}T${timePart}+08:00`
    if (Number.isFinite(Date.parse(iso))) return iso
  }
  return expireIso
}

function formatNumber(n) {
  if (!Number.isFinite(n)) return "0"
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 })
}

function parseTokenLimit(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : undefined
  const text = String(raw ?? "").trim()
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(text)
  if (!m) return undefined
  const base = Number(m[1])
  if (!Number.isFinite(base) || base <= 0) return undefined
  const unit = m[2]?.toLowerCase()
  const mult = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1
  return Math.round(base * mult)
}

function describePackage(series, pkg, hasOtherActive) {
  const status = String(pkg?.PackageStatus ?? "").trim().toUpperCase()
  if (status === "UNPURCHASED" || !status) return null

  const usedRaw = Number(pkg.TotalUsed ?? 0)
  // CycleCredits is the current cycle's allowance; TotalCredits is cumulative across all cycles.
  const cycleRaw = Number(pkg.CycleCredits ?? 0)
  const totalRaw = cycleRaw > 0 ? cycleRaw : Number(pkg.TotalCredits ?? 0)
  const used = Number.isFinite(usedRaw) && usedRaw >= 0 ? usedRaw : 0
  const total = Number.isFinite(totalRaw) && totalRaw >= 0 ? totalRaw : 0
  const remaining = total - used
  const percent = total > 0 ? Math.round((used / total) * 1000) / 10 : undefined
  const tier = tierLabel(pkg.PrepayInquiryKey)
  const resetsAt = cycleResetTime(pkg)

  // Progress bar window: keep name short and omit amount/limit/unit so Magpie
  // renders a crisp single-line `已用 xx%` without awkward line wrapping or
  // duplicated `每天用掉的积分` clutter.
  const bar = {
    name: series.label,
    ...(percent !== undefined ? { used: percent } : { used: 0 }),
    ...(resetsAt ? { resetsAt } : {}),
    ...((status === "EXPIRED" || status === "USED_UP") && hasOtherActive ? { aside: true } : {}),
  }

  let detailText
  if (status === "EXPIRED") {
    detailText = total > 0 ? `${formatNumber(used)} / ${formatNumber(total)} · 已过期` : "已过期"
  } else if (total > 0) {
    const remStr = remaining <= 0 ? "已用尽" : `余 ${formatNumber(remaining)}`
    detailText = `${formatNumber(used)} / ${formatNumber(total)}（${remStr}）`
  } else {
    detailText = `已用 ${formatNumber(used)}`
  }

  const detail = {
    name: `${series.label}积分`,
    display: detailText,
    text: true,
  }

  return {
    series,
    status,
    tier,
    used,
    total,
    remaining,
    bar,
    detail,
  }
}

async function readUsage(cred) {
  if (!cred.secretId || !cred.secretKey) {
    return {
      error: "未配置腾讯云 SecretId / SecretKey，仅支持对话；请重新登录补全以启用额度查询",
      signIn: "kept",
      windows: [],
    }
  }
  const targets = seriesListOf(cred.seriesMode)
  const settled = await Promise.allSettled(
    targets.map(async (series) => ({
      series,
      pkg: await callTokenHub(cred, "DescribeTokenPlanPersonalPackage", { ProductType: series.productType }),
    })),
  )

  const ok = settled.filter((r) => r.status === "fulfilled").map((r) => r.value)
  const errs = settled.filter((r) => r.status === "rejected").map((r) => r.reason)
  if (!ok.length) {
    const first = errs[0]
    return {
      error: first?.message || "查询个人版 Token Plan 额度失败",
      signIn: "kept",
      windows: [],
    }
  }

  const hasActive = ok.some(({ pkg }) => String(pkg?.PackageStatus ?? "").toUpperCase() === "ACTIVE")
  const entries = ok
    .map(({ series, pkg }) => describePackage(series, pkg, hasActive))
    .filter(Boolean)

  if (!entries.length) {
    return {
      error: `当前账号尚未开通个人版 Token Plan（${cred.site.label}），请前往控制台开通：${cred.site.consoleURL}`,
      signIn: "kept",
      windows: [],
    }
  }

  const planParts = entries.map((e) => (e.tier ? `${e.series.label} ${e.tier}` : e.series.label))
  const windows = [
    ...entries.map((e) => e.bar),
    ...entries.map((e) => e.detail),
  ]

  if (errs.length) {
    const failedNames = targets
      .filter((_, idx) => settled[idx].status === "rejected")
      .map((s) => s.label)
      .join("、")
    windows.push({
      name: `${failedNames}状态`,
      display: `查询失败：${errs[0].message}`,
      text: true,
    })
  }

  const out = {
    plan: planParts.join(" + "),
    windows,
    signIn: "kept",
  }
  if (cred.accountName) out.user = cred.accountName
  return out
}

async function fetchAllTextModels(cred) {
  const limit = 100
  const first = await callTokenHub(cred, "DescribeModelList", { Limit: limit, Offset: 0, ModelTypes: ["Text"] })
  const total = Number(first?.TotalCount ?? 0)
  const pages = Math.max(0, Math.ceil(total / limit) - 1)
  const rest = pages > 0
    ? await Promise.all(
        Array.from({ length: pages }, (_, i) =>
          callTokenHub(cred, "DescribeModelList", { Limit: limit, Offset: (i + 1) * limit, ModelTypes: ["Text"] }),
        ),
      )
    : []
  const byId = new Map()
  for (const page of [first, ...rest]) {
    for (const m of page?.ModelSet ?? []) {
      if (m?.ModelId) byId.set(String(m.ModelId), m)
    }
  }
  return byId
}

function toModel(item, spec, baseURL, previous) {
  const id = String(item.ModelId)
  const tags = Array.isArray(spec?.Tags) ? spec.Tags : []
  const modelSpec = spec?.ModelSpec ?? {}
  const context = parseTokenLimit(modelSpec.ContextLength) ?? (previous?.limit?.context || 128_000)
  const output = parseTokenLimit(modelSpec.MaxOutputToken) ?? (previous?.limit?.output || 16_384)

  const hasVisionTag = tags.includes("视觉理解") || tags.includes("多模态理解")
  const hasReasoningTag = tags.includes("深度思考")
  const image = spec ? hasVisionTag : Boolean(previous?.capabilities?.input?.image)
  const reasoning = spec ? hasReasoningTag : Boolean(previous?.capabilities?.reasoning)

  return {
    ...previous,
    id,
    providerID: PROVIDER,
    name: String(spec?.DisplayName || item.DisplayName || spec?.ModelName || previous?.name || id),
    api: { id, url: baseURL, npm: "@ai-sdk/openai-compatible" },
    limit: { context, output },
    capabilities: {
      ...previous?.capabilities,
      reasoning,
      toolcall: previous?.capabilities?.toolcall !== false,
      input: {
        ...previous?.capabilities?.input,
        text: true,
        image,
      },
      output: {
        ...previous?.capabilities?.output,
        text: true,
      },
    },
    variants: previous?.variants ?? {},
  }
}

async function fetchPersonalModels(cred, previousModels = {}) {
  let targetSeries = seriesListOf(cred.seriesMode)
  if (cred.seriesMode === "auto") {
    const pkgResults = await Promise.allSettled(
      SERIES.map(async (s) => ({
        series: s,
        pkg: await callTokenHub(cred, "DescribeTokenPlanPersonalPackage", { ProductType: s.productType }),
      })),
    )
    const owned = pkgResults
      .filter((r) => r.status === "fulfilled" && OWNED_MODEL_STATUSES.has(String(r.value.pkg?.PackageStatus ?? "").toUpperCase()))
      .map((r) => r.value.series)
    if (owned.length) {
      targetSeries = owned
    } else {
      const authErr = pkgResults.find((r) => r.status === "rejected" && r.reason?.refused)?.reason
      if (authErr && pkgResults.every((r) => r.status === "rejected")) throw authErr
    }
  }

  const [seriesModelResults, catalogResult] = await Promise.all([
    Promise.allSettled(
      targetSeries.map(async (s) => ({
        series: s,
        models: (await callTokenHub(cred, "DescribeTokenPlanPersonalModelList", { ProductType: s.productType }))?.Models ?? [],
      })),
    ),
    fetchAllTextModels(cred).catch(() => null),
  ])

  const okLists = seriesModelResults.filter((r) => r.status === "fulfilled").map((r) => r.value)
  if (!okLists.length) {
    const firstErr = seriesModelResults.find((r) => r.status === "rejected")?.reason
    throw firstErr || new Error("拉取个人版可用模型列表失败")
  }

  const merged = new Map()
  for (const { models } of okLists) {
    for (const item of models) {
      const id = String(item?.ModelId ?? "").trim()
      if (!id || merged.has(id)) continue
      merged.set(id, item)
    }
  }

  const out = {}
  for (const [id, item] of merged) {
    const spec = catalogResult?.get(id)
    const status = String(spec?.Status ?? "").trim().toLowerCase()
    if (status && OFFLINE_STATUSES.has(status)) continue
    out[id] = toModel(item, spec, cred.site.chatURL, previousModels[id])
  }
  return Object.keys(out).length ? out : previousModels
}

async function startSignIn() {
  const html = (await Bun.file(SIGNIN_PAGE).text())
    .replaceAll("{{CN_CAM_URL}}", SITES.cn.camURL)
    .replaceAll("{{CN_CONSOLE_URL}}", SITES.cn.consoleURL)
    .replaceAll("{{INTL_CAM_URL}}", SITES.intl.camURL)
    .replaceAll("{{INTL_CONSOLE_URL}}", SITES.intl.consoleURL)

  const secret = crypto.randomUUID()
  let finish
  const done = new Promise((resolve) => (finish = resolve))

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== `/${secret}`) return new Response("Not found", { status: 404 })
      if (req.method === "GET") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
      if (req.method !== "POST") return new Response(null, { status: 405 })

      const body = await req.json().catch(() => ({}))
      const siteKey = body.site === "intl" ? "intl" : "cn"
      const series = body.series === "common" || body.series === "hy" ? body.series : "auto"
      const secretId = String(body.secretId ?? "").trim()
      const secretKey = String(body.secretKey ?? "").trim()
      let apiKey = String(body.apiKey ?? "").trim()
      const accountName = String(body.accountName ?? "").trim()

      if (!secretId || !secretKey) {
        return Response.json({ error: "请填写腾讯云 SecretId 与 SecretKey" }, { status: 400 })
      }

      const cred = {
        secretId,
        secretKey,
        token: "",
        siteKey,
        site: siteOf(siteKey),
        seriesMode: series,
        accountName,
      }

      try {
        await callTokenHub(cred, "DescribeTokenPlanPersonalPackage", { ProductType: "personal" })
        if (!apiKey) {
          apiKey = (await fetchPersonalApiKey(cred)).secret
        }
      } catch (e) {
        return Response.json({ error: e.message || "验证失败" }, { status: 400 })
      }

      const metadata = {
        secretId,
        secretKey,
        site: siteKey,
        series,
        ...(accountName ? { accountName } : {}),
      }
      finish({ type: "success", key: apiKey, metadata })
      return Response.json({ ok: true })
    },
  })

  const timer = setTimeout(() => finish({ type: "failed", error: "登录超时，请重新登录" }), SIGNIN_TIMEOUT_MS)
  done.then(() => setTimeout(() => (clearTimeout(timer), server.stop(true)), 1000))
  return { url: `http://127.0.0.1:${server.port}/${secret}`, done }
}

export default {
  id: "tencent-token-plan",
  server: async () => ({
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "Tencent Token Plan",
        npm: "@ai-sdk/openai-compatible",
        api: SITES.cn.chatURL,
        models: buildDefaultModels(SITES.cn.chatURL),
      }
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "oauth",
          label: "配置腾讯云个人版密钥（自动拉取额度与模型）",
          async authorize() {
            const { url, done } = await startSignIn()
            return {
              url,
              instructions: "magpie 已在浏览器打开配置页：填入 SecretId / SecretKey（apiKey 留空可自动获取），提交后个人版额度与模型会自动同步。",
              method: "auto",
              callback: () => done,
            }
          },
        },
        {
          type: "api",
          label: "仅填写个人版共享 API Key（sk-tp-…）",
          placeholder: "sk-tp-…（仅对话，无额度查询）",
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth?.key) return {}
        const cred = credOf(auth)
        return { baseURL: cred.site.chatURL, apiKey: cred.apiKey }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api") return { error: "未登录个人版 Token Plan", windows: [] }
        return readUsage(credOf(auth))
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const cred = credOf(auth)
        if (auth?.type !== "api" || !cred.secretId || !cred.secretKey) return provider.models
        return fetchPersonalModels(cred, provider.models ?? {})
      },
    },
  }),
}

export const _internal = {
  PROVIDER,
  SITES,
  SERIES,
  signTC3,
  callTokenHub,
  fetchPersonalApiKey,
  describePackage,
  readUsage,
  fetchAllTextModels,
  fetchPersonalModels,
  toModel,
  credOf,
  parseTencentTime,
  cycleResetTime,
  parseTokenLimit,
  formatNumber,
}
