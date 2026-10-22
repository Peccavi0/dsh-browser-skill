# dsh-browser-skill

A [DeepSeek Harness](https://github.com/deepseek-ai) bundle that turns the `bsk` (browser-skill) CLI
into **one bounded model tool** — a fixed command inventory, a fixed parameter schema, and a session
lifecycle the model cannot invent its way out of.

```
model ──> tool(browser_skill) ──> bsk CLI ──> your real Chromium
```

## Why a bundle and not just "run this shell command"

Giving a model a shell and a CLI doc means every call is an improvisation: wrong flag order, a
`--session` on a command that rejects one, a forgotten `session stop` that leaks a browser session.
This bundle compresses the whole surface into three fields — `command`, `args`, `session` — and refuses
anything outside the enum:

| Field | Type | Rule |
|---|---|---|
| `command` | string, **enum** | One of the documented `bsk` subcommands. Unknown → tool error before spawn. |
| `args` | string[] | Extra argv tokens, one per flag or positional value. |
| `session` | string | The 4-letter id from `session start`; appended as `--session <id>`, except for commands that reject it. |

The bundle also knows which commands are sessionless (`session start`, `browsers`, `status`, …) and
which take the id positionally (`session stop`), so the model never has to.

## Requirements

- **DeepSeek Harness** `>= 0.2.1-rc.2`
- **`bsk` on `PATH`** (or set `binaryPath` — see below)
- A Chromium-family browser with the browser-skill extension installed and logged in

The bundle does not ship `bsk` itself; it only wraps it.

## Install

A DSH bundle is a package whose `package.json` carries `dsh.bundle.patch`. Install it into a profile the
same way as any workspace bundle:

```bash
git clone https://github.com/Peccavi0/dsh-browser-skill.git
cd dsh-browser-skill

# install into a profile by absolute path (a `link:` dependency)
dsh plugin --profile <profile-name> add link:/absolute/path/to/dsh-browser-skill
```

Then make sure the bundle is listed under `dsh.profile.bundles` in that profile's `package.json` and
restart the profile. `cordis.patch.yml` inserts the plugin row:

```yaml
- insert:
    - id: browser-skill
      name: 'dsh-browser-skill'
```

## Configuration

Both keys are optional — the defaults work when `bsk` is on `PATH`.

```yaml
- insert:
    - id: browser-skill
      name: 'dsh-browser-skill'
      config:
        binaryPath: 'C:\path\to\bsk.exe'   # default: "bsk"
        cwd: 'E:\some\workspace'           # default: the session working directory
```

## The tool contract

The model sees one tool. Its description encodes the rules that matter:

- start with `session start`, keep the printed 4-letter id, pass it as `session` on every session-scoped call
- **always** run `session stop`, on the success path *and* the error path
- work observe-act-observe: `observe` after a navigation or a meaningful DOM change, and act on fresh
  `@eN` refs instead of CSS selectors
- page writes only affect the **Agent Window** — use `tab list --scope user` + `tab borrow` before
  touching one of the user's own tabs
- use `request-help` for login, captcha, OTP, payment or consent steps instead of brute-forcing

Commands, verbatim:

```
session start | session stop | session list | browsers | status | doctor | update | logs
navigate | navigate-back | navigate-forward | reload | wait-for-navigation | wait-ms
observe | snapshot | get-html | screenshot | console | network
click | hover | fill | select | press | evaluate
tab list | tab create | tab close | tab select | tab borrow | tab return
window resize | emulate | upload | download | request-help | record start | record stop
```

### Implementation notes

- **No `@deepseek-ai/*` imports.** A workspace bundle is installed as a link, so Harness packages are
  not resolvable from the checkout. Everything here is Node builtins plus the mounted `subprocess` and
  `tools` services.
- **Prefer the subprocess service, fall back to `node:child_process`.** When the profile exposes
  `subprocess`, the child runs through it (cancellation + byte caps for free); otherwise a plain spawn
  with the same caps applies.
- **Bounded output.** `256 KiB` per stream, truncated rather than buffered unbounded.
- **Bounded time.** 180 s internal deadline under a 240 s registry deadline; both fuse with the caller's
  abort signal.

## 中文说明

这是把 `bsk`（browser-skill）命令行包成**一个受约束的模型工具**的 DSH 插件。

模型只能填三个字段：`command`（枚举，编不出枚举外的命令）、`args`、`session`。
会话生命周期（`session start` → 用 id → `session stop`）和「只在 Agent Window 里写、动用户的标签页前先
`tab borrow`」这两条规则写进了工具描述，不靠模型自觉。

安装：把仓库克隆到本地，用 `dsh plugin --profile <profile> add link:<绝对路径>` 装进 profile，
确认 `dsh.profile.bundles` 里有它，然后重启 profile。

配置：`binaryPath`（默认 `bsk`，走 PATH）、`cwd`（默认会话工作目录）。

## This is also a minimal DSH bundle reference

Nine files, no build step, no dependencies, no `@deepseek-ai/*` imports. If you want to see the
smallest thing that is still a real DSH bundle, read it top to bottom here.

```
package.json        4 exports + one dsh.bundle.patch pointer  ← the only "magic"
cordis.patch.yml    one insert row: id + package name + config
index.js            export name / inject / apply, and one ctx.tools.register call
locale/*.json       UI label for the settings surface (optional)
icon.svg            panel icon (optional)
LICENSE, README     normal repo furniture
```

The load path is short and worth knowing:

```tree
profile package.json
  dsh.profile.bundles[]
    → package dsh.bundle.patch  → cordis.patch.yml
      → insert: { id, name, config }
        → import('<pkg>')  → apply(ctx, config)
          → ctx.tools.register({ name, description, parameters, output, execute })
```

**Three things that are not obvious and cost time if you learn them the hard way:**

1. **A workspace bundle is installed as a `link:`**, so `@deepseek-ai/*` is not resolvable from the
   link target. The harness lives in the profile's `node_modules`, not next to your source. Write the
   schema by hand and import Node builtins only — that is why `index.js` here has no imports beyond
   `node:child_process`.
2. **`inject` is a real contract, not decoration.** `export const inject = ['tools']` makes the plugin
   wait for the tool registry; without it `ctx.tools` may be undefined at `apply` time.
3. **The parameter schema is validated**, so it must stay inside the harness's supported JSON Schema
   subset — no `$ref`, no conditionals. The `command` enum here is doing most of the safety work.

A client half (`./client` export + `dsh.client.platform: "web"`) is only needed if you want UI:
a panel, a sidebar entry, a custom renderer. A host-only bundle like this one needs none of it.

## Upstream, and when not to use this

This is an **unofficial** adapter. It wraps the `bsk` CLI and contains no BrowserSkill code.

- Upstream project: **[Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill)** — MIT, the CLI + extension this bundle drives.
- **Tencent ships an official DeepSeek Harness plugin:**
  [`@wxg-prc-cpg/browser-skill-dsh-plugin`](https://github.com/Tencent/BrowserSkill/tree/main/packages/dsh-plugin-browserskill).
  **If you want *a* DSH plugin for browser-skill, install that one** — it is maintained upstream and
  covers more surface (structured extraction, screenshots, policy tooling).

So when would you want this repo instead? Only if you specifically want the thin version described
above: exactly one tool, a closed command enum, no extra behaviours, nothing to keep in sync beyond
the command list.

This project is not affiliated with, endorsed by, or supported by Tencent. `bsk` and the browser
extension are not vendored here — install them from upstream first.

中文：本项目是**非官方**适配层，只把 `bsk` 命令行包成一个受约束的工具，不含 BrowserSkill 的任何代码。
上游 [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill) 已经提供了官方 DSH 插件
`@wxg-prc-cpg/browser-skill-dsh-plugin`，**只是想要一个能用的 DSH 插件的话请装官方的**；
本仓库只适合想用「单一工具、封闭命令枚举、最小面」这个极简形态的场景。

## License

MIT — for this adapter only. BrowserSkill itself is MIT and belongs to its own authors.
