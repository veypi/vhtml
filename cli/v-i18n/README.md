# v-i18n CLI

vhtml 项目的国际化（i18n）管理工具。

## 安装

```bash
go install github.com/veypi/vhtml/cmd/v-i18n@latest
```

## 快速开始

```bash
# 扫描代码中的 i18n key，自动排序、清理并报告缺失
v-i18n scan

# 添加翻译（支持管道、-json 参数或位置参数）
echo '{"zh-CN":{"hello":"你好"},"en-US":{"hello":"Hello"}}' | v-i18n add
v-i18n add -json '{"zh-CN":{"hello":"你好"},"en-US":{"hello":"Hello"}}'
v-i18n add '{"zh-CN":{"hello":"你好"},"en-US":{"hello":"Hello"}}'
```

## 命令

### scan - 扫描代码

`scan` 会执行以下操作：
- 扫描代码中所有 `$t('key')` 形式的翻译 key
- 自动对翻译文件进行排序
- 自动清理未使用的 key
- 自动清理值为空的 key
- 自动清理代码中已不存在的 key
- 保存文件后输出统计信息和缺失的 key 列表
- 如果存在缺失项，自动输出建议执行的 `v-i18n add` 命令

### 内置保留键（`_` 前缀）

以 `_` 开头的 key 是内置动态翻译保留入口（如 `_theme.dark`、`_err.INVALID_TOKEN`），用于变量拼接、后端错误码等无法静态扫描到的动态翻译场景：

```js
$t('_theme.' + t.key)      // 动态拼接，key 由变量决定
$t('_err.' + err.code)     // 后端错误码动态翻译
$t(c.titleKey)             // titleKey: '_home.case_video_title'（变量赋值引用）
```

保留键规则：
- 不参与缺失检查（代码中提取到的 `_` 开头字面量直接跳过）
- 不参与未引用检查（`--autoremove` 不会删除）
- 由 langs.json 手动维护，scan 输出中单独统计显示数量

```bash
v-i18n scan

# 显示所有缺失的 key（不省略）
v-i18n scan --verbose
```

### add - 添加翻译

支持三种传入 JSON 的方式：

```bash
# 方式 1：管道
echo '{"zh-CN":{"key":"值"},"en-US":{"key":"value"}}' | v-i18n add

# 方式 2：-json 参数
v-i18n add -json '{"zh-CN":{"key":"值"},"en-US":{"key":"value"}}'

# 方式 3：位置参数
v-i18n add '{"zh-CN":{"key":"值"},"en-US":{"key":"value"}}'
```

JSON 格式为：

```json
{
  "zh-CN": {
    "common.save": "保存",
    "common.cancel": "取消"
  },
  "en-US": {
    "common.save": "Save",
    "common.cancel": "Cancel"
  }
}
```

## 全局参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--entry` | 扫描入口目录 | `./ui` |
| `--output` | 翻译文件路径 | `./ui/langs.json` |
| `--languages` | 支持的语言 | `zh-CN,en-US` |
| `--defaultLanguage` | 默认语言 | `zh-CN` |
| `--indent` | JSON 缩进空格数 | `2` |
| `--sortKeys` | 是否对 key 排序 | `true` |

## 查看帮助

```bash
v-i18n --help
v-i18n scan --help
v-i18n add --help
```
