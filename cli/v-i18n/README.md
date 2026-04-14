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
