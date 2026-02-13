# v-i18n CLI

vhtml 项目的国际化（i18n）管理工具。

## 安装

```bash
go install github.com/veypi/vhtml/cmd/v-i18n@latest
```

安装完成后，使用 `v-i18n` 命令。

## 快速开始

```bash
# 扫描代码中的 i18n key，自动创建翻译文件
v-i18n scan --fix

# 同步所有语言文件
v-i18n sync
```

## 常用命令

### scan - 扫描代码

```bash
# 扫描并显示报告
v-i18n scan

# 自动添加缺失的 key
v-i18n scan --fix

# 填充默认值
v-i18n scan --fix --fill "TODO"
```

### sync - 同步语言文件

```bash
# 同步所有语言（以 defaultLanguage 为基准）
v-i18n sync

# 以 zh-CN 为基准同步 en-US
v-i18n sync --source zh-CN --target en-US
```

### add - 添加翻译

```bash
# 添加单个 key
v-i18n add --key "common.save" --value "保存"

# 添加多语言值
v-i18n add --key "common.cancel" --values '{"zh-CN":"取消","en-US":"Cancel"}'
```

### remove - 删除翻译

```bash
# 删除 key
v-i18n remove --key "deprecated.key" --yes
```

### stats - 查看统计

```bash
v-i18n stats
```

### export/import - 导出导入

```bash
# 导出为 CSV
v-i18n export --dest translations.csv

# 导入 CSV
v-i18n import --input translations.csv
```

## 全局参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--entry` | 扫描入口目录 | `./ui` |
| `--output` | 翻译文件路径 | `./ui/langs.json` |
| `--languages` | 支持的语言 | `zh-CN,en-US` |
| `--defaultLanguage` | 默认语言 | `zh-CN` |

## 查看帮助

```bash
# 查看所有命令
v-i18n --help

# 查看具体命令帮助
v-i18n scan --help
v-i18n sync --help
v-i18n add --help
```
