# magpie-tokenhub-personal

[magpie](https://github.com/yetone/magpie) 插件：为腾讯云大模型服务平台 **TokenHub 个人版 Token Plan**（同时支持 **通用 Token Plan** 与 **Hy Token Plan**）接入实时额度监控、自动获取共享 API Key，以及动态模型与能力标签同步。

> **为什么需要这个插件？**
> magpie 内置的 `tencent-cloud` preset 目前只对接了企业版接口（`DescribeTokenPlanList`）与静态 `models.dev` 目录，个人版账号会报 `no Token Plan Enterprise`。本插件直接对接腾讯云官方个人版管控面 API，补齐**个人版双套餐额度**与**实时模型/规格发现**。

## 特性

- **双套餐额度聚合**（`DescribeTokenPlanPersonalPackage`）：
  - 同时查询 **通用 Token Plan**（`personal`）与 **Hy Token Plan**（`personal-hunyuan`），自动跳过未购买系列；
  - 在 `magpie quota`、桌面端卡片与状态栏展示各套餐已用积分、总积分、使用百分比、套餐档位（Lite / Standard / Pro / Max）、当前周期、到期时间及自动续费标记；
  - 两个套餐并发查询，单侧失败不丢另一侧数据，已过期套餐自动设为 `aside` 避免影响路由。
- **动态模型发现与能力补全**（`DescribeTokenPlanPersonalModelList` + `DescribeModelList`）：
  - 根据已激活的个人版套餐自动合并可用模型（去重，过滤 `discontinued` / `offline` / `pre-offline` 状态）；
  - 实时拉取每个模型的 `ContextLength`（上下文窗口）、`MaxOutputToken`（最大输出），以及 `Tags`（`深度思考` → `reasoning`、`视觉理解`/`多模态理解` → `input.image`）；
  - 保留用户在 magpie 中已配置的 `options` / `variants`。
- **免手动复制共享 API Key**：
  - 登录时填入腾讯云 CAM `SecretId` / `SecretKey`，若共享 API Key（`sk-tp-…`）留空，插件自动调用 `DescribeTokenPlanPersonalApiKey` + `DescribeTokenPlanPersonalApiKeySecret` 拉取明文并存入 magpie；
  - 支持中国站（`cn` · `ap-guangzhou` → `https://tokenhub.tencentmaas.com/plan/v3`）与国际站（`intl` · `ap-singapore` → `https://tokenhub-intl.tencentmaas.com/plan/v3`）。
- **零外部依赖**：纯 ESM + Node/Bun 内置 `node:crypto` 实现 `TC3-HMAC-SHA256` 签名，不依赖全局安装 `thcli`。

## 安装与使用

### 从 GitHub 安装

```sh
magpie plugin add github:Lqg97/magpie-tokenhub-personal
```

### 或本地安装

```sh
git clone https://github.com/Lqg97/magpie-tokenhub-personal.git
magpie plugin add ./magpie-tokenhub-personal
```

### 登录配置

```sh
magpie plugin login tencent-token-plan
```

浏览器会打开本机 `127.0.0.1` 临时配置页（10 分钟有效，提交后自动关闭）：

1. 选择站点（**中国站** / **国际站**）与套餐范围（默认 **自动识别通用版 + Hy 版**）；
2. 填入腾讯云 CAM 的 **SecretId** 与 **SecretKey**（用于校验与查询套餐额度、动态模型列表）；
3. **共享 API Key (`sk-tp-…`)** 可留空（自动通过云 API 拉取）或手动粘贴；
4. 点击「验证并添加」即可。

> 如果此前启用的内置 `tencent-cloud` 会产生企业版报错，建议停用内置预设，改用本插件提供的 `tencent-token-plan/*`：
> ```sh
> magpie provider off tencent-cloud
> ```

### 常用命令验证

```sh
magpie quota tencent-token-plan          # 查看通用版 + Hy 版个人套餐积分进度
magpie provider models tencent-token-plan # 刷新并查看个人版可用模型与能力
magpie provider test tencent-token-plan   # 测试对话连通性
```

## 权限说明（CAM 子账号如使用）

若使用主账号密钥可直接全量访问；若使用 CAM 子账号密钥，需确保具备 TokenHub 只读/个人套餐查询相关权限（`DescribeTokenPlanPersonalPackage`、`DescribeTokenPlanPersonalModelList`、`DescribeModelList`，若需自动取 Key 还需 `DescribeTokenPlanPersonalApiKey` / `DescribeTokenPlanPersonalApiKeySecret`）。

## 测试

```sh
npm test
```

## License

[MIT](LICENSE)
