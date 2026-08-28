//! T10 多模型切换：输入栏内嵌的模型/提供商选择器。

import { MODEL_PRESETS } from "../models";
import type { ModelPreset } from "../models";

export default function ModelSwitcher({
  provider,
  model,
  onProvider,
  onModel,
}: {
  provider: string;
  model: string;
  onProvider: (preset: ModelPreset) => void;
  onModel: (model: string) => void;
}) {
  const preset = MODEL_PRESETS.find((p) => p.id === provider) ?? null;
  return (
    <div className="model-switch">
      <select
        value={provider}
        onChange={(e) => {
          const p = MODEL_PRESETS.find((x) => x.id === e.target.value);
          if (p) onProvider(p);
        }}
        title="模型提供商"
      >
        {MODEL_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select
        value={model}
        onChange={(e) => onModel(e.target.value)}
        title="模型"
        disabled={!preset}
      >
        {preset?.models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </div>
  );
}