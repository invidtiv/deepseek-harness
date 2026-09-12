# Agent Note: DeepSeek 目录行声明图片输入

Status: implemented

[English](2026-09-12-deepseek-catalog-image-input.md) | 中文

## Problem

DeepSeek 直连适配器提供可处理图片的目录项：`deepseek-flash`（V41 Flash）与 `deepseek-v4-flash-vision-exp` 都声明 `inputModalities: ['text', 'image']`，正是它决定该路由的请求图片预算、Files API 上传路径与路由计价。Models 设置页既无法表达也无法展示该字段。其 DeepSeek 目录编辑器只写入 `id`、`name` 与两个容量字段，而设置段是把 `models` 作为单个值整体替换的——数组字段没有逐项的适配器默认值回退。因此，拥有该数组的用户既没有在产品界面声明图片输入的途径，也无从看出某一行已丢失该能力。

失效在请求携带图片之前一直静默。仅文本路由会通过 `projectTextOnlyImages` 投影历史，把每张图片替换为占位文本；`read_image` 工具则以 `does not declare image input` 拒绝。一份沿用的目录若把可处理图片的 flash 模型钉在 `inputModalities: ['text']`，该模型就处于失明状态，而页面上没有任何信号。

## Decision

每个 DeepSeek 目录行的折叠区在两个容量字段旁增加一个**图片输入**复选框。勾选写入适配器的 `['text', 'image']`，取消勾选写入其 `['text']`；编辑器只写入这两个集合，因此该控件无法写入适配器会拒绝的目录值。各行仍保留其任意隐藏字段，与之前一致，因此一次复选框编辑不会丢掉说明字段或手工设置的请求预算。

该折叠区原标签为**容量**；它现在承载一个非容量字段，因此在共用 `modelAdvanced` 的两个编辑器中统一改标为**高级**。

pi-ai 与自定义提供方编辑器（`ModelListEditor`）刻意保持不变。其模型字段是 `input` 而非 `inputModalities`，且其路由带有模型项可继承的 `defaultInput`，同类问题在那里并不以相同形式存在；对称的控件被延期，而不是在不同 schema 下重复实现。

## Alternatives considered

**针对任意模态集合的多选控件。** 适配器接受 `text` 与 `image` 的任意非空、无重复子集，因此通用控件才是最忠实的做法。但没有任何已发布目录项或消费方区分「仅文本」与「文本加图片」之外的情形，而集合编辑器会鼓励写出 `['image']` 这种无人需要的路由。用一个布尔量覆盖两种真实目录，是更小的正确控件。

**保持该字段仅在 YAML 中可编辑，只修用户的文档。** 编辑器本就保留它不展示的字段，因此手工编辑 `settings.yaml` 可行且仍受支持。但这解决不了可发现性缺口：行的图片能力在拥有该数组的产品界面上依旧不可见、不可设置。

**在同一次改动中为 pi-ai 编辑器也加上该控件。** 两个编辑器共用 `modelAdvanced` 与行布局，但不共用字段名、schema 和继承规则。把未经测试的第二套 schema 捆进本次改动，只会扩大评审面，而对所报告缺口没有任何覆盖。

## Consequences

DeepSeek 目录行的图片能力现在在所到之处都可见、可编辑。用户的仅文本覆盖配置可以在原地修复，而不必手工编辑设置文档；新增行在勾选之前为仅文本——与适配器自身的默认值一致。

图片请求预算（`imagePixelBudget`、`imageMaxBytes`）、`systemPromptUpdate` 与 `description` 仍仅可在 YAML 中设置，不受该控件影响；折叠区现在把一个布尔量与两个容量字段混在一起，这也是其标签从字段名改为**高级**的原因。

包内组件测试覆盖了继承行的两个方向（可处理图片的行失去图片输入、仅文本的行获得图片输入），以及新增行在写入前声明图片输入。展开的 DeepSeek 行以及共用该标签的两份折叠行快照，其双语配对的金标 aria 快照已随新控件重新录制。
