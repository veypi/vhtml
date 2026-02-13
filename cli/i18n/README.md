# v-i18n CLI

vhtml 项目的国际化（i18n）管理工具，用于扫描、检查、同步翻译文件。

## 功能特性

- 🔍 **扫描** - 自动扫描代码中的 i18n key
- ✅ **检查** - 检查缺失、未使用的翻译 key
- 🔄 **同步** - 保持多语言文件 key 一致
- ➕ **管理** - 添加、删除、重命名 key

## 安装

```bash
go install github.com/veypi/vhtml/cli/i18n@latest
```

## 快速开始

```bash
# 扫描代码并检查缺失的翻译
v-i18n scan

# 同步所有语言文件（以 zh-CN 为基准）
v-i18n sync
```

## 全局参数

所有命令都支持以下全局参数：

| 参数                   | 类型       | 默认值                       | 说明                 |
| ---------------------- | ---------- | ---------------------------- | -------------------- |
| `--entry`              | `string`   | `"./ui"`                     | 扫描入口目录         |
| `--output`             | `string`   | `"./ui/langs.json"`          | 翻译文件输出路径     |
| `--languages`          | `string[]` | `["zh-CN", "en-US"]`         | 支持的语言列表       |
| `--defaultLanguage`    | `string`   | `"zh-CN"`                    | 默认语言（同步基准） |
| `--include`            | `string[]` | `["**/*.html", "**/*.js"]`   | 扫描文件匹配模式     |
| `--exclude`            | `string[]` | `["node_modules/**", "dist/**", ".git/**"]` | 排除文件模式         |
| `--pattern`            | `string`   | `\$t\(['"]([^'"]+)['"]`      | 匹配 i18n key 的正则 |
| `--indent`             | `int`      | `2`                          | JSON 缩进空格数      |
| `--sortKeys`           | `boolean`  | `true`                       | 是否按 key 排序      |

**示例：**

```bash
# 指定入口目录和输出文件
v-i18n scan --entry ./src --output ./langs.json

# 指定多语言
v-i18n sync --languages zh-CN en-US ja-JP --defaultLanguage zh-CN

# 自定义扫描规则
v-i18n scan --include "**/*.vue" --pattern 't\(['"']([^'"']+)['"']\)'
```

## 命令详解

### `scan` - 扫描代码

扫描源代码中的 i18n key，检查缺失和未使用的翻译。

```bash
v-i18n scan [options]
```

**选项:**

| 选项              | 类型      | 默认值 | 说明                         |
| ----------------- | --------- | ------ | ---------------------------- |
| `--fix`           | `boolean` | `false`| 自动修复缺失 key（添加空值） |
| `--remove-unused` | `boolean` | `false`| 删除未使用的 key             |
| `--fill`          | `string`  | `""`   | 缺失 key 的填充值            |

**示例:**

```bash
# 扫描并显示报告
v-i18n scan

# 扫描并自动添加缺失的 key
v-i18n scan --fix

# 扫描并用 "TODO" 填充缺失项
v-i18n scan --fix --fill "TODO"

# 扫描并删除未使用的 key（谨慎使用）
v-i18n scan --remove-unused
```

**输出示例:**

```
┌─────────────────────────────────────────────────────┐
│ 扫描结果                                             │
├─────────────────────────────────────────────────────┤
│ 发现 key: 128 个                                     │
│ 现有 key: 115 个                                     │
├─────────────────────────────────────────────────────┤
│ 缺失翻译 (3)                                         │
│   ❌ zh-CN: 0 个                                     │
│   ❌ en-US: 3 个                                     │
│      - preview.copy                                  │
│      - preview.copySuccess                           │
│      - preview.copyError                             │
├─────────────────────────────────────────────────────┤
│ 未使用 key (2)                                       │
│   ⚠️  common.deprecated                              │
│   ⚠️  home.oldFeature                                │
└─────────────────────────────────────────────────────┘
```

---

### `sync` - 同步语言文件

以默认语言为基准，同步其他语言文件的 key 结构。

```bash
v-i18n sync [options]
```

**选项:**

| 选项       | 类型       | 默认值            | 说明                         |
| ---------- | ---------- | ----------------- | ---------------------------- |
| `--source` | `string`   | `defaultLanguage` | 源语言                       |
| `--target` | `string[]` | `所有其他语言`    | 目标语言                     |
| `--syncFill` | `string`   | `""`              | 缺失值的填充内容             |
| `--mark`   | `boolean`  | `true`            | 标记待翻译项（添加 🔴 前缀） |

**示例:**

```bash
# 同步所有语言（以 defaultLanguage 为基准）
v-i18n sync

# 以 zh-CN 为基准同步 en-US
v-i18n sync --source zh-CN --target en-US

# 同步并填充 "TODO" 标记
v-i18n sync --syncFill "TODO" --mark
```

---

### `add` - 添加翻译

批量添加新的翻译 key。

```bash
v-i18n add [options]
```

**选项:**

| 选项       | 类型      | 默认值 | 说明                  |
| ---------- | --------- | ------ | --------------------- |
| `--key`    | `string`  | `""`   | 要添加的 key（必填）  |
| `--value`  | `string`  | `""`   | 默认值（所有语言）    |
| `--values` | `string`  | `"{}"` | 各语言值（JSON 格式） |
| `--nested` | `boolean` | `true` | 自动创建嵌套对象      |

**示例:**

```bash
# 添加单个 key（所有语言为空）
v-i18n add --key "user.profile.title"

# 添加并指定默认值
v-i18n add --key "common.save" --value "保存"

# 添加并指定多语言值
v-i18n add --key "common.cancel" --values '{"zh-CN":"取消","en-US":"Cancel"}'
```

---

### `remove` - 删除翻译

删除指定的翻译 key。

```bash
v-i18n remove [options]
```

**选项:**

| 选项        | 类型      | 默认值  | 说明         |
| ----------- | --------- | ------- | ------------ |
| `--key`        | `string`  | `""`    | 要删除的 key |
| `--yes`        | `boolean` | `false` | 跳过确认     |
| `--usePattern` | `boolean` | `false` | 使用正则匹配 |

**示例:**

```bash
# 删除单个 key
v-i18n remove --key "user.profile.title"

# 删除并跳过确认
v-i18n remove --key "deprecated.key" --yes

# 批量删除匹配模式的 key
v-i18n remove --key "deprecated\\..*" --usePattern --yes
```

---

### `rename` - 重命名翻译

重命名翻译 key，自动更新源代码中的引用。

```bash
v-i18n rename [options]
```

**选项:**

| 选项              | 类型      | 默认值  | 说明                 |
| ----------------- | --------- | ------- | -------------------- |
| `--oldKey`        | `string`  | `""`    | 原 key 名称          |
| `--newKey`        | `string`  | `""`    | 新 key 名称          |
| `--update-source` | `boolean` | `true`  | 更新源代码中的引用   |
| `--dry-run`       | `boolean` | `false` | 预览变更，不实际执行 |

**示例:**

```bash
# 重命名 key
v-i18n rename --oldKey "user.name" --newKey "user.username"

# 预览变更
v-i18n rename --oldKey "user.name" --newKey "user.username" --dry-run

# 只修改翻译文件，不更新源代码
v-i18n rename --oldKey "user.name" --newKey "user.username" --update-source=false
```

---

### `export` - 导出翻译

导出翻译为其他格式（CSV、JSON）。

```bash
v-i18n export [options]
```

**选项:**

| 选项             | 类型                  | 默认值  | 说明                   |
| ---------------- | --------------------- | ------- | ---------------------- |
| `--dest`         | `string`              | `translations.csv` | 输出文件路径  |
| `--exportFormat` | `csv\|json`           | `csv`   | 导出格式               |
| `--exportLangs`  | `string[]`            | `全部`  | 导出的语言             |
| `--flat`         | `boolean`             | `false` | 扁平化 key（如 a.b.c） |
| `--only-missing` | `boolean`             | `false` | 只导出缺失翻译的项     |

**示例:**

```bash
# 导出为 CSV
v-i18n export --dest translations.csv

# 导出为 JSON
v-i18n export --dest translations.json --exportFormat json

# 只导出 en-US 的缺失项
v-i18n export --dest missing.csv --exportLangs en-US --only-missing

# 导出扁平化 JSON
v-i18n export --dest translations.json --exportFormat json --flat
```

**CSV 格式示例:**

```csv
key,zh-CN,en-US,context
common.save,保存,Save,通用按钮
common.cancel,取消,Cancel,通用按钮
user.welcome,欢迎 {name},Welcome {name},变量插值
```

---

### `import` - 导入翻译

从其他格式导入翻译。

```bash
v-i18n import [options]
```

**选项:**

| 选项          | 类型                  | 默认值  | 说明                 |
| ------------- | --------------------- | ------- | -------------------- |
| `--input`     | `string`              | `""`    | 输入文件路径（必填） |
| `--format`    | `csv\|json`           | `auto`  | 导入格式（自动检测） |
| `--language`  | `string`              | `全部`  | 导入的目标语言       |
| `--overwrite` | `boolean`             | `false` | 覆盖已有翻译         |
| `--dry-run`   | `boolean`             | `false` | 预览变更             |

**示例:**

```bash
# 导入 CSV
v-i18n import --input translations.csv

# 导入并覆盖
v-i18n import --input translations.csv --overwrite

# 只导入特定语言
v-i18n import --input translations.csv --language en-US

# 预览导入结果
v-i18n import --input translations.csv --dry-run
```

---

### `stats` - 统计信息

显示翻译覆盖率等统计信息。

```bash
v-i18n stats [options]
```

**选项:**

| 选项       | 类型               | 默认值  | 说明     |
| ---------- | ------------------ | ------- | -------- |
| `--statsOutput` | `string`           | `""`    | 输出文件 |
| `--statsFormat` | `table\|json\|csv` | `table` | 输出格式 |

**示例:**

```bash
# 显示统计
v-i18n stats

# 输出 JSON
v-i18n stats --statsFormat json --statsOutput stats.json
```

**输出示例:**

```
┌──────────┬────────┬────────┬──────────┐
│ Language │ Total  │ Done   │ Coverage │
├──────────┼────────┼────────┼──────────┤
│ zh-CN    │ 128    │ 128    │ 100%     │
│ en-US    │ 128    │ 115    │ 89.8%    │
└──────────┴────────┴────────┴──────────┘
```

---

## 完整示例

### 初始化翻译文件

```bash
# 创建空的翻译文件（扫描时会自动创建）
v-i18n scan
```

### 日常开发流程

```bash
# 1. 开发时扫描，检查是否有遗漏
v-i18n scan

# 2. 自动添加缺失的 key（用空值或 TODO 填充）
v-i18n scan --fix --fill "TODO"

# 3. 翻译完成后同步其他语言
v-i18n sync
```

### 清理流程

```bash
# 1. 扫描未使用的 key
v-i18n scan

# 2. 确认后删除
v-i18n scan --remove-unused

# 3. 或者手动删除特定 key
v-i18n remove --key "deprecated.key" --yes
```

### 导入导出工作流

```bash
# 导出给翻译人员
v-i18n export --dest to-translate.csv --only-missing

# 导入翻译后的文件
v-i18n import --input translated.csv --overwrite
```

## 最佳实践

1. **命名规范**: 使用 `模块.子模块.描述` 的层级结构，如 `user.profile.title`
2. **定期扫描**: 在提交前运行 `v-i18n scan` 检查遗漏
3. **保持同步**: 添加新功能后及时 `sync` 到其他语言
4. **避免硬编码**: 所有用户可见文本都使用 i18n key
5. **注释标记**: 复杂 key 添加注释说明使用场景

## 常见问题

**Q: 扫描结果不准确？**
A: 使用 `--pattern` 参数自定义正则表达式，匹配你的 `$t()` 调用方式。

**Q: 如何支持 Vue/React 等其他框架？**
A: 使用 `--pattern` 参数匹配对应框架的语法，如 `--pattern 't\(['"']([^'"']+)['"']\)'`。

**Q: 能否集成到构建流程？**
A: 可以，`stats` 和 `scan` 命令都可以配合 CI 检查，通过返回值判断是否有缺失翻译。
