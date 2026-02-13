# v-i18n CLI

vhtml 项目的国际化（i18n）管理工具，用于扫描、检查、同步翻译文件。

## 功能特性

- 🔍 **扫描** - 自动扫描代码中的 i18n key
- ✅ **检查** - 检查缺失、未使用的翻译 key
- 🔄 **同步** - 保持多语言文件 key 一致
- ➕ **管理** - 添加、删除、重命名 key

## 安装

```bash
# 或本地安装
```

## 快速开始

```bash
# 扫描代码并检查缺失的翻译
v-i18n scan
# 同步所有语言文件（以 zh-CN 为基准）
v-i18n sync
```

## 配置文件

`.v-i18n.json` 或 `v-i18n.config.js`:

```json
{
  "entry": "./ui",
  "output": "./ui/langs.json",
  "languages": ["zh-CN", "en-US"],
  "defaultLanguage": "zh-CN",
  "scan": {
    "include": ["**/*.html", "**/*.js"],
    "exclude": ["node_modules/**", "dist/**"],
    "pattern": "\\$t\\(['\"]([^'\"]+)['\"]"
  },
  "format": {
    "indent": 2,
    "sortKeys": true,
    "trailingComma": true
  }
}
```

### 配置项说明

| 配置项                 | 类型       | 默认值                | 说明                 |
| ---------------------- | ---------- | --------------------- | -------------------- |
| `entry`                | `string`   | `"./ui"`              | 扫描入口目录         |
| `output`               | `string`   | `"./ui/langs.json`    | 翻译文件输出路径     |
| `languages`            | `string[]` | `["zh-CN", "en-US"]`  | 支持的语言列表       |
| `defaultLanguage`      | `string`   | `"zh-CN"`             | 默认语言（同步基准） |
| `scan.include`         | `string[]` | `["**/*.html"]`       | 扫描文件匹配模式     |
| `scan.exclude`         | `string[]` | `["node_modules/**"]` | 排除文件模式         |
| `scan.pattern`         | `string`   | 内置正则              | 匹配 i18n key 的正则 |
| `format.indent`        | `number`   | `2`                   | 缩进空格数           |
| `format.sortKeys`      | `boolean`  | `true`                | 是否按 key 排序      |
| `format.trailingComma` | `boolean`  | `true`                | 是否保留尾随逗号     |

## 命令详解

```bash
v-i18n init [options]
```

**选项:**

| 选项       | 简写 | 类型       | 默认值               | 说明         |
| ---------- | ---- | ---------- | -------------------- | ------------ |
| `--config` | `-c` | `string`   | `.v-i18n.json`       | 配置文件名   |
| `--lang`   | `-l` | `string[]` | `["zh-CN", "en-US"]` | 初始化语言   |
| `--yes`    | `-y` | `boolean`  | `false`              | 使用默认配置 |

**示例:**

```bash
# 交互式初始化
v-i18n init

# 使用默认配置快速初始化
v-i18n init -y

# 指定语言和配置文件
v-i18n init -l zh-CN en-US ja-JP -c i18n.config.js
```

---

### `scan` - 扫描代码

扫描源代码中的 i18n key，检查缺失和未使用的翻译。

```bash
v-i18n scan [options]
```

**选项:**

| 选项              | 简写 | 类型                   | 默认值    | 说明                         |
| ----------------- | ---- | ---------------------- | --------- | ---------------------------- |
| `--fix`           | `-f` | `boolean`              | `false`   | 自动修复缺失 key（添加空值） |
| `--remove-unused` | `-r` | `boolean`              | `false`   | 删除未使用的 key             |
| `--output`        | `-o` | `string`               | 控制台    | 输出报告文件路径             |
| `--format`        |      | `json\|markdown\|html` | `console` | 报告格式                     |

**示例:**

```bash
# 扫描并显示报告
v-i18n scan

# 扫描并自动添加缺失的 key
v-i18n scan --fix

# 扫描并生成 JSON 报告
v-i18n scan -o report.json --format json

# 扫描并删除未使用的 key（谨慎使用）
v-i18n scan --remove-unused
```

**输出示例:**

```
┌─────────────────────────────────────────────────────┐
│ 扫描结果                                             │
├─────────────────────────────────────────────────────┤
│ 扫描文件: 24 个                                      │
│ 发现 key: 128 个                                     │
│ 有效 key: 115 个                                     │
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

| 选项       | 简写 | 类型       | 默认值            | 说明                         |
| ---------- | ---- | ---------- | ----------------- | ---------------------------- |
| `--source` | `-s` | `string`   | `defaultLanguage` | 源语言                       |
| `--target` | `-t` | `string[]` | `所有其他语言`    | 目标语言                     |
| `--fill`   |      | `string`   | `""`              | 缺失值的填充内容             |
| `--mark`   | `-m` | `boolean`  | `true`            | 标记待翻译项（添加 🔴 前缀） |

**示例:**

```bash
# 同步所有语言（以 defaultLanguage 为基准）
v-i18n sync

# 以 zh-CN 为基准同步 en-US
v-i18n sync -s zh-CN -t en-US

# 同步并填充 "TODO" 标记
v-i18n sync --fill "TODO" --mark
```

---

### `add` - 添加翻译

批量添加新的翻译 key。

```bash
v-i18n add <key> [options]
```

**选项:**

| 选项       | 简写 | 类型      | 默认值 | 说明                  |
| ---------- | ---- | --------- | ------ | --------------------- |
| `--value`  | `-v` | `string`  | `""`   | 默认值（所有语言）    |
| `--values` |      | `string`  | `{}`   | 各语言值（JSON 格式） |
| `--nested` | `-n` | `boolean` | `true` | 自动创建嵌套对象      |

**示例:**

```bash
# 添加单个 key（所有语言为空）
v-i18n add "user.profile.title"

# 添加并指定默认值
v-i18n add "common.save" -v "保存"

# 添加并指定多语言值
v-i18n add "common.cancel" --values '{"zh-CN":"取消","en-US":"Cancel"}'

# 批量添加（通过管道）
echo "common.ok\ncommon.cancel\ncommon.save" | v-i18n add
```

---

### `remove` - 删除翻译

删除指定的翻译 key。

```bash
v-i18n remove <key> [options]
```

**选项:**

| 选项        | 简写 | 类型      | 默认值  | 说明         |
| ----------- | ---- | --------- | ------- | ------------ |
| `--yes`     | `-y` | `boolean` | `false` | 跳过确认     |
| `--pattern` | `-p` | `boolean` | `false` | 使用正则匹配 |

**示例:**

```bash
# 删除单个 key
v-i18n remove "user.profile.title"

# 删除并跳过确认
v-i18n remove "deprecated.key" -y

# 批量删除匹配模式的 key
v-i18n remove "deprecated\\..*" -p -y
```

---

### `rename` - 重命名翻译

重命名翻译 key，自动更新源代码中的引用。

```bash
v-i18n rename <oldKey> <newKey> [options]
```

**选项:**

| 选项              | 简写 | 类型      | 默认值  | 说明                 |
| ----------------- | ---- | --------- | ------- | -------------------- |
| `--update-source` | `-u` | `boolean` | `true`  | 更新源代码中的引用   |
| `--dry-run`       | `-d` | `boolean` | `false` | 预览变更，不实际执行 |

**示例:**

```bash
# 重命名 key
v-i18n rename "user.name" "user.username"

# 预览变更
v-i18n rename "user.name" "user.username" --dry-run

# 只修改翻译文件，不更新源代码
v-i18n rename "user.name" "user.username" --no-update-source
```

---

### `export` - 导出翻译

导出翻译为其他格式（CSV、Excel、JSON）。

```bash
v-i18n export [output] [options]
```

**选项:**

| 选项             | 简写 | 类型                  | 默认值  | 说明                   |
| ---------------- | ---- | --------------------- | ------- | ---------------------- |
| `--format`       | `-f` | `csv\|xlsx\|json\|po` | `csv`   | 导出格式               |
| `--languages`    | `-l` | `string[]`            | `全部`  | 导出的语言             |
| `--flat`         |      | `boolean`             | `false` | 扁平化 key（如 a.b.c） |
| `--only-missing` | `-m` | `boolean`             | `false` | 只导出缺失翻译的项     |

**示例:**

```bash
# 导出为 CSV
v-i18n export translations.csv

# 导出为 Excel
v-i18n export translations.xlsx -f xlsx

# 只导出 en-US 的缺失项
v-i18n export missing.csv -l en-US --only-missing

# 导出扁平化 JSON
v-i18n export translations.json -f json --flat
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
v-i18n import <input> [options]
```

**选项:**

| 选项          | 简写 | 类型                  | 默认值  | 说明                 |
| ------------- | ---- | --------------------- | ------- | -------------------- |
| `--format`    | `-f` | `csv\|xlsx\|json\|po` | `auto`  | 导入格式（自动检测） |
| `--language`  | `-l` | `string`              | `全部`  | 导入的目标语言       |
| `--overwrite` | `-o` | `boolean`             | `false` | 覆盖已有翻译         |
| `--dry-run`   | `-d` | `boolean`             | `false` | 预览变更             |

**示例:**

```bash
# 导入 CSV
v-i18n import translations.csv

# 导入并覆盖
v-i18n import translations.csv --overwrite

# 只导入特定语言
v-i18n import translations.csv -l en-US

# 预览导入结果
v-i18n import translations.xlsx --dry-run
```

---

### `stats` - 统计信息

显示翻译覆盖率等统计信息。

```bash
v-i18n stats [options]
```

**选项:**

| 选项       | 简写 | 类型               | 默认值  | 说明     |
| ---------- | ---- | ------------------ | ------- | -------- |
| `--output` | `-o` | `string`           | 控制台  | 输出文件 |
| `--format` | `-f` | `table\|json\|csv` | `table` | 输出格式 |

**示例:**

```bash
# 显示统计
v-i18n stats

# 输出 JSON
v-i18n stats -f json -o stats.json
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

## 工作流示例

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
v-i18n remove "deprecated.key"
```

## 最佳实践

1. **命名规范**: 使用 `模块.子模块.描述` 的层级结构，如 `user.profile.title`
2. **定期扫描**: 在提交前运行 `v-i18n scan` 检查遗漏
3. **保持同步**: 添加新功能后及时 `sync` 到其他语言
4. **避免硬编码**: 所有用户可见文本都使用 i18n key
5. **注释标记**: 复杂 key 添加注释说明使用场景

## 常见问题

**Q: 扫描结果不准确？**
A: 检查 `scan.pattern` 配置是否匹配你的 `$t()` 调用方式。

**Q: 如何支持 Vue/React 等其他框架？**
A: 修改配置中的 `scan.pattern` 匹配对应框架的语法，如 `t\(['"]([^'"]+)['"]`。

**Q: 能否集成到构建流程？**
A: 可以，使用 `--format json` 输出报告，配合 CI 检查。
