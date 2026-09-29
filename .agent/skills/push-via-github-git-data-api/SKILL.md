---
name: push-via-github-git-data-api
description: 当 git push / git fetch / git ls-remote 在沙箱里挂住或超时（但 curl 访问 api.github.com 正常）时使用，用 GitHub Git Data API（blobs→trees→commits→refs）绕开 git 的 HTTPS 传输层完成推送。也适用于需要精确构造远程 commit/tree 对象的场景。触发词：git push 卡住、git push 超时、ls-remote timeout、push 不出去、Git Data API、无法推送、远程 ref 更新。
agent_created: true
---

# 用 GitHub Git Data API 推送（绕开 git 传输层）

## 症状

- `git push` 长时间无输出后超时，或跑 30+ 分钟才拿到服务器响应
- `git ls-remote origin` 90 秒超时（`exit 124`）且**无任何输出**
- `git push` 在管道里接 `sed` 时被沙箱 SIGTERM，连 `GIT_TRACE` 都没来得及输出
- **但** `curl -x http://127.0.0.1:<port> https://api.github.com/` 返回 200，1–3 秒

## 快速判定

```bash
# 1. 代理下 curl 通不通（用实际可用的代理端口）
curl -sS -m 15 -o /dev/null -w "api: HTTP %{http_code} in %{time_total}s\n" https://api.github.com/
# 2. git 协议握手通不通
timeout 90 git ls-remote origin refs/heads/main; echo "EXIT=$?"
```

- curl 200 且 ls-remote 超时 → **就是这个问题**，走下面的 API 路径
- 两个都通 → 别用这个技能，直接 push

> Windows 上 `curl` 偶发 `schannel: CRYPT_E_REVOCATION_OFFLINE (0x80092013)`，
> 加 `--ssl-no-revoke` 即可。`git config http.schannelCheckRevoke false` 对 git 无效。

## 完整流程

只需要 4 个调用。先确认待推送对象很少：

```bash
git rev-list --objects <remote_sha>..HEAD | wc -l
```

### 1) 上传 blob

**关键：必须上传 git blob 的字节，不是工作区文件的字节**（见下方陷阱 A）。

```bash
git cat-file -p <local_blob_sha> > /tmp/canonical.bin   # 或 git show HEAD:path
```

```python
import base64, json, os, urllib.request
TOKEN = os.environ['GH_TOKEN']
API   = 'https://api.github.com/repos/<owner>/<repo>'
PROXY = 'http://127.0.0.1:10808'
opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({'https': PROXY, 'http': PROXY}))

def api(method, path, payload=None):
    req = urllib.request.Request(
        API + path, method=method,
        data=json.dumps(payload).encode() if payload else None,
        headers={'Authorization': f'Bearer {TOKEN}',
                 'Accept': 'application/vnd.github+json',
                 'Content-Type': 'application/json'})
    with opener.open(req, timeout=180) as r:
        return json.load(r)

content = open('/tmp/canonical.bin', 'rb').read()
out = api('POST', '/git/blobs',
          {'content': base64.b64encode(content).decode(), 'encoding': 'base64'})
print('blob sha =', out['sha'])
```

`Authorization: Bearer <PAT>` 即可。**不要把 token 放进 URL**（会进 shell history 和日志）。

### 2) 建 tree（用 base_tree 增量）

`base_tree` = 远程父提交的 tree sha。只列**改动**的路径，其余自动继承。

```python
tree = api('POST', '/git/trees', {
    'base_tree': '<parent_commit_tree_sha>',
    'tree': [
        {'path': 'docs/i18n/strings.json', 'mode': '100644',
         'type': 'blob', 'sha': '<blob_sha>'},
        # 新增文件同理；删除文件用 {'path': ..., 'mode': '100644',
        #                          'type': 'blob', 'sha': None}
    ],
})
print('tree sha =', tree['sha'])
```

`mode` 必须显式给：`100644` 普通文件、`100755` 可执行、`120000` 符号链接、
`160000` gitlink（子模块）。

### 3) 建 commit

```python
msg = open('/tmp/msg.txt', encoding='utf-8').read().rstrip('\n')  # 见陷阱 B
c = api('POST', '/git/commits', {
    'message': msg,
    'tree': tree['sha'],
    'parents': ['<parent_sha>'],
    'author':    {'name': '...', 'email': '...', 'date': '2026-01-01T00:00:00Z'},
    'committer': {'name': '...', 'email': '...', 'date': '2026-01-01T00:00:00Z'},
})
print('commit sha =', c['sha'])
```

**父提交必须等于当前远程 HEAD**，否则下一步会 422（见下）。

### 4) 更新 ref

```bash
curl -sS -m 60 --ssl-no-revoke -X PATCH \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" -H "Content-Type: application/json" \
  -d '{"sha":"<commit_sha>","force":false}' \
  "https://api.github.com/repos/<owner>/<repo>/git/refs/heads/main"
```

**`force:false` 是有意为之**：远程已前进时会返回
`422 {"message":"Update is not a fast forward"}`，这正是你要的安全网。
看到这个错 → 说明你的 commit 父不是远程 HEAD，重新建 commit。

> curl 比 Python `urllib` 更稳（Python 那次在这台机器上被 SIGTERM 了）。
> 敏感操作优先用 curl。

## 两个字节级陷阱（都会静默产出错误内容）

### 陷阱 A：`core.autocrlf=true` 下不能上传工作区字节

Windows 上 `git add` 会把工作区 CRLF 转成 LF 存 blob。用 API 直接读磁盘文件上传
**绕过了这个转换**，于是远程存的是 CRLF 版本，与 git 期望的不一致。

本项目实例：`docs/i18n/strings.json` 工作区 2282589 字节（全 CRLF），
git blob 2236090 字节（全 LF），46499 个换行全部受影响。

**修法**：从 git 取规范字节，而不是读磁盘。

```bash
git cat-file -p <blob_sha> > /tmp/canonical.bin   # blob_sha 来自 git rev-parse HEAD:path
```

**验证**（这是最硬的证明）：

```python
import hashlib
d = open('/tmp/canonical.bin','rb').read()
print(hashlib.sha1(b'blob %d\0' % len(d) + d).hexdigest())
# 必须等于 git rev-parse HEAD:<path>
```

### 陷阱 B：API 建的 commit 与你本地 `commit-tree` 重建的 SHA 会有细微差别

拿 API 返回的 `message` 去做本地 `git commit-tree`，SHA 常常差一个字节。
实测有**两个**独立来源，别只猜一个：

1. **尾随换行**。GitHub 是否给消息补 `\n` 取决于你发过去的内容 ——
   同一个脚本，一次需要补、一次不需要。**两个都试，取匹配的那个**。
2. **时区偏移被保留，只是 JSON 显示成 Z**。API 的 `author.date` 返回
   `2026-09-23T00:11:48Z`，但提交对象里存的是**原始偏移** `+0800`。
   重建时必须用**本地 commit 自己的偏移**（`git log -1 --format=%aI`），
   而不是 API 显示的那个 Z。用 `+0000` 会算出不同的 SHA。

最稳的做法：不要靠推理，**穷举这两个维度**，取等于远程 SHA 的那个组合。
现成脚本：`~/.workbuddy-ai/tmp/realign.py <remote_sha>`（见下方「让本地与远程 SHA 完全对齐」）。

**差一字节的坑（踩过）**：`git log -1 --format=%B` 在输出消息之后**自己还会补一个换行**。
所以对它的输出做 `head -c -1` 得到的其实是 **git 存储的消息本身**（已含尾换行），
而不是「去掉尾换行的消息」。要拿后者得 `head -c -2`。搞反了就会得到
「消息 2422B / 远程 2421B」这种看似只差一点、实际永远匹配不上的局面 ——
而 4 个组合全不中时，人会先怀疑时间戳，不会怀疑自己差了一字节。

```python
import datetime, hashlib
ts = int(datetime.datetime.fromisoformat(local_iso).timestamp())
def build(off, extra_nl):
    body = (b'tree %s\nparent %s\n'
            b'author %s <%s> %d %s\ncommitter %s <%s> %d %s\n\n'
            % (tree.encode(), par.encode(),
               name.encode(), email.encode(), ts, off.encode(),
               name.encode(), email.encode(), ts, off.encode())
            + msg + (b'\n' if extra_nl else b''))
    return hashlib.sha1(b'commit %d\0' % len(body) + body).hexdigest()

for off in ('+0000', '+0800', '+0900', ...):   # 含本地偏移
    for nl in (False, True):
        if build(off, nl) == remote_sha:
            print('match:', off, nl)
```

拿到匹配组合后，用对应的 `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` 跑
`git commit-tree`，本地就能复现远程 SHA，两边彻底对齐。

```bash
cat msgbody.txt > msg_with_nl.txt; printf '\n' >> msg_with_nl.txt
```

## 让本地与远程 SHA 完全对齐（可选，但很值）

如果本地已有内容相同但 SHA 不同的 commit（因为走了 API 而不是 push），
可以**离线重建远程的 commit 对象**，避免以后 `git pull` 冲突。

**直接跑脚本**：`~/.workbuddy-ai/tmp/realign.py <remote_sha>` ——
它会从 API 取回远程 commit 的 tree/parents/author/committer/message，
把「消息带不带尾换行」×「日期用本地偏移还是 +0000」四个组合全试一遍，
命中后打印结果并退出 0。命中后再：

```bash
git update-ref refs/heads/main <remote_sha>
git reset --hard <remote_sha>          # 同步工作区（tree 相同，不会丢改动）
git rev-parse HEAD                     # 应等于 <remote_sha>
```

注意两点：

- **不要用 `git update-ref refs/heads/main <remote_sha>` 直接对齐**，
  除非那个 commit 对象在本地已经存在 —— 否则报
  `trying to write ref … with nonexistent object`。所以必须先 `commit-tree` 重建。
- `refs/remotes/origin/main` 是 3 段 ref，在沙箱里写入可能被静默丢弃
  （见 `fix-sandboxed-git-refs`）。反正远程真相以 API 为准，
  下次推送的 parent 也从 API 读，别依赖本地 remote-tracking ref。

手写版本（脚本不适用时）：

```bash
export GIT_AUTHOR_NAME=... GIT_AUTHOR_EMAIL=... \
       GIT_COMMITTER_NAME=... GIT_COMMITTER_EMAIL=...
export GIT_AUTHOR_DATE="2026-01-01T00:00:00+00:00" \
       GIT_COMMITTER_DATE="2026-01-01T00:00:00+00:00"
git commit-tree <tree_sha> -p <parent_sha> < msg_with_nl.txt   # 应复现远程 commit sha
git update-ref refs/heads/main <remote_sha>
git reset --hard <remote_sha>
git rev-list --left-right --count refs/remotes/origin/main...HEAD   # 期望 0  0
```

重建 tree（当远程 tree 只在远程存在时）：

```bash
export GIT_INDEX_FILE=/tmp/tmpindex
rm -f "$GIT_INDEX_FILE"
git read-tree <base_tree_sha>
git update-index --add --cacheinfo "100644,<blob_sha>,<path>"
git write-tree                  # 应复现远程 tree sha
unset GIT_INDEX_FILE; rm -f /tmp/tmpindex
```

## 验证：tree sha 相等 == 内容逐字节相等

这是最可靠的等价性断言，比逐文件 diff 更硬：

```python
# 远程 commit 的 tree sha 应等于本地 commit 的 tree sha
assert remote['tree']['sha'] == local_tree_sha
```

**别用 type→mode 映射去比对 tree 条目**。踩过的坑：写
`{'blob':'100644','tree':'040000','commit':'160000'}` 这种映射会忽略 API 返回的
真实 `mode`，把 `gradlew` 的 `100755` 误报成 `100644`，凭空造出「远程丢了可执行位」
这个假缺陷。**要用 `e['mode']` 原值。**

## 触发 CI

通过 API 更新 `refs/heads/*` **会正常触发** `push` 事件和 workflow run，
和 `git push` 效果一样。触发后照常用
`GET /repos/{o}/{r}/actions/runs` 和 `/actions/runs/{id}/jobs` 查状态。

### 但推送有副作用：它会**取消**上一次 push run

如果 workflow 里有
```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}-${{ github.event_name }}
  cancel-in-progress: true
```
group 里**没有 sha**，那么同一分支上所有 push 共享一组 —— **新 push 取消在飞的那次**。
实测（本项目 2026-09-23）：为了推一个只改 workflow 的后续 commit，
取消掉了正在跑的 run，**白丢一个已跑 29 分钟的 arm64 构建**。

所以**「顺手推一个小改动」不是免费的**。推之前先查有没有在飞的 run：
```bash
gh api "repos/$R/actions/runs?per_page=5&status=in_progress" \
  --jq '.workflow_runs[] | "#\(.run_number) \(.event) \(.status)"'
```
在飞的长 job 值得等（或明确接受它的工作被丢弃）再推。
被取消的 job 在 API 里是 **`completed/cancelled`**，不是 `failure` —— 别误判成构建失败。


## 安全

- PAT 一旦出现在对话/日志里，**提醒用户吊销**。
- 显示 remote URL 时掩码：`git remote -v | sed 's|https://[^@]*@|https://***TOKEN***@|g'`
- 用 `GH_TOKEN` 环境变量传 token，不要放进 argv。
