import React, { useState, useEffect } from 'react';
import { MessageService } from '../shared/message';
import {
  LLMApiMode,
  LLMProvider,
  MODEL_PRESETS_UPDATED_AT,
  PROVIDER_PRESETS,
  PROVIDER_ORDER,
  defaultApiModeForProvider,
  normalizeLLMConfig,
  normalizeLLMModelList,
} from '../services/llm/types';
import type { LLMConfig, LLMModelInfo } from '../services/llm/types';

interface AISettingsProps {
  dataRevision?: number;
}

interface SyncedModelCatalog {
  provider: LLMProvider;
  baseUrl: string;
  models: LLMModelInfo[];
}

const DEFAULT_CONFIG: LLMConfig = {
  provider: LLMProvider.DEEPSEEK,
  apiKey: '',
  baseUrl: PROVIDER_PRESETS[LLMProvider.DEEPSEEK].baseUrl,
  model: PROVIDER_PRESETS[LLMProvider.DEEPSEEK].defaultModel,
  models: PROVIDER_PRESETS[LLMProvider.DEEPSEEK].models,
  apiMode: LLMApiMode.CHAT_COMPLETIONS,
};

export function AISettings({ dataRevision = 0 }: AISettingsProps) {
  const [config, setConfig] = useState<LLMConfig>(DEFAULT_CONFIG);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'fail' | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [saved, setSaved] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveFailed, setSaveFailed] = useState(false);
  const [newModel, setNewModel] = useState('');
  const [modelCatalog, setModelCatalog] = useState<SyncedModelCatalog | null>(null);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const [modelCatalogMessage, setModelCatalogMessage] = useState('');
  const [modelCatalogFailed, setModelCatalogFailed] = useState(false);
  /** 用户是否手动编辑过 API 地址；为 true 时切换服务商不覆盖地址 */
  const [urlEdited, setUrlEdited] = useState(false);
  /** 用户是否手动编辑过模型名称；为 true 时切换服务商不覆盖模型 */
  const [modelEdited, setModelEdited] = useState(false);

  useEffect(() => {
    const loadConfig = () => MessageService.sendMessage({ type: 'GET_LLM_CONFIG' }).then(res => {
      if (res.success && res.data) {
        const stored = res.data as LLMConfig;
        setConfig(normalizeLLMConfig(stored));
        // 已保存的值若不是该服务商的官方默认值，视为自定义并予以保留
        const storedPreset = PROVIDER_PRESETS[stored.provider];
        setUrlEdited(stored.baseUrl.trim() !== (storedPreset?.baseUrl ?? '').trim());
        setModelEdited(stored.model.trim() !== (storedPreset?.defaultModel ?? '').trim());
      } else if (res.success) {
        setConfig(DEFAULT_CONFIG);
        setUrlEdited(false);
        setModelEdited(false);
      }
    });
    void loadConfig();
    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName === 'local' && changes.llmConfig) void loadConfig();
    };
    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, [dataRevision]);

  const preset = PROVIDER_PRESETS[config.provider] ?? PROVIDER_PRESETS[LLMProvider.CUSTOM];
  const savedModels = normalizeLLMModelList(config.models, config.model);
  const syncedModels = modelCatalog
    && modelCatalog.provider === config.provider
    && modelCatalog.baseUrl === config.baseUrl.trim()
    ? modelCatalog.models
    : [];
  const selectableModels = normalizeLLMModelList(
    [
      ...savedModels,
      ...preset.models,
      ...(preset.reasoningModels ?? []),
      ...syncedModels.map(model => model.id),
    ],
    config.model,
  );
  const formatModelLabel = (modelId: string) => {
    const displayName = syncedModels.find(model => model.id === modelId)?.displayName
      ?? preset.modelLabels?.[modelId];
    return displayName ? `${displayName}（${modelId}）` : modelId;
  };

  const handleProviderChange = (provider: LLMProvider) => {
    const next = PROVIDER_PRESETS[provider];
    setConfig({
      ...config,
      provider,
      // 用户手动改过的地址/模型不再覆盖，避免自定义代理与模型被重置
      baseUrl: urlEdited ? config.baseUrl : next.baseUrl,
      model: modelEdited ? config.model : next.defaultModel,
      models: modelEdited
        ? normalizeLLMModelList(config.models, config.model)
        : normalizeLLMModelList(next.models, next.defaultModel),
      apiMode: defaultApiModeForProvider(provider),
    });
    setTestResult(null);
    setErrorMsg('');
    setModelCatalogMessage('');
    setModelCatalogFailed(false);
  };

  const handleBaseUrlChange = (baseUrl: string) => {
    setUrlEdited(true);
    setConfig({ ...config, baseUrl });
    setModelCatalogMessage('');
    setModelCatalogFailed(false);
  };

  const handleModelChange = (model: string) => {
    setModelEdited(true);
    setConfig({
      ...config,
      model,
      models: normalizeLLMModelList(config.models, model),
    });
  };

  const handleAddModel = () => {
    const model = newModel.trim();
    if (!model) return;
    setModelEdited(true);
    setConfig({
      ...config,
      model,
      models: normalizeLLMModelList(config.models, model),
    });
    setNewModel('');
  };

  const handleRemoveModel = (model: string) => {
    if (savedModels.length === 1) return;
    const models = savedModels.filter(item => item !== model);
    setModelEdited(true);
    setConfig({
      ...config,
      models,
      model: config.model === model ? models[0] : config.model,
    });
  };

  /** 把地址恢复为当前服务商的官方默认值 */
  const handleResetBaseUrl = () => {
    setUrlEdited(false);
    setConfig({ ...config, baseUrl: preset.baseUrl });
    setModelCatalogMessage('');
    setModelCatalogFailed(false);
  };

  /** 把模型恢复为当前服务商的默认模型 */
  const handleResetModel = () => {
    setModelEdited(false);
    setConfig({
      ...config,
      model: preset.defaultModel,
      models: normalizeLLMModelList(preset.models, preset.defaultModel),
    });
  };

  const handleSave = async () => {
    const response = await MessageService.sendMessage<{ localSaved: boolean; sync: string }>({
      type: 'SAVE_LLM_CONFIG',
      payload: normalizeLLMConfig(config),
    });
    setSaved(response.success);
    setSaveFailed(!response.success);
    setSaveMessage(
      response.success
        ? response.data?.sync === 'queued'
          ? '已保存到本地，同步已排队'
          : '已保存到本地'
        : response.error || '保存失败',
    );
    setTimeout(() => setSaved(false), 2000);
  };

  const handleLoadModelCatalog = async () => {
    setModelCatalogLoading(true);
    setModelCatalog(null);
    setModelCatalogMessage('');
    setModelCatalogFailed(false);

    const normalizedConfig = normalizeLLMConfig(config);
    const response = await MessageService.sendMessage<{ models: LLMModelInfo[] }>({
      type: 'LIST_LLM_MODELS',
      payload: normalizedConfig,
    });

    if (response.success && Array.isArray(response.data?.models)) {
      const models = response.data.models;
      setModelCatalog({
        provider: normalizedConfig.provider,
        baseUrl: normalizedConfig.baseUrl.trim(),
        models,
      });
      const firstModel = models[0]?.id;
      if (firstModel) {
        setConfig(current => (
          current.model.trim()
          || current.provider !== normalizedConfig.provider
          || current.baseUrl.trim() !== normalizedConfig.baseUrl.trim()
            ? current
            : {
                ...current,
                model: firstModel,
                models: normalizeLLMModelList(current.models, firstModel),
              }
        ));
      }
      setModelCatalogMessage(`已读取 ${models.length} 个可用于对话的模型`);
    } else {
      setModelCatalogFailed(true);
      setModelCatalogMessage(response.error || '读取模型列表失败，已保留内置推荐和现有模型');
    }

    setModelCatalogLoading(false);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setErrorMsg('');
    // 传入当前界面填写的配置，无需先保存即可测试
    const res = await MessageService.sendMessage({
      type: 'TEST_LLM_CONNECTION',
      payload: normalizeLLMConfig(config),
    });
    setTestResult(res.success ? 'success' : 'fail');
    if (!res.success) setErrorMsg(res.error || '连接失败，请检查配置');
    setTesting(false);
  };

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">AI 模型设置</h2>
      <p className="settings-description">
        配置 AI 服务后，插件可以自动生成开放性问题的回答、智能解析简历、以及语义匹配表单字段。
      </p>

      <div className="settings-field">
        <label>服务商</label>
        <select
          value={config.provider}
          onChange={e => handleProviderChange(e.target.value as LLMProvider)}
          className="settings-input"
        >
          {PROVIDER_ORDER.map(p => (
            <option key={p} value={p}>{PROVIDER_PRESETS[p].label}</option>
          ))}
        </select>
      </div>

      <div className="settings-field">
        <label>API Key</label>
        <input
          type="password"
          value={config.apiKey}
          onChange={(event) => {
            setConfig({ ...config, apiKey: event.target.value });
            setModelCatalog(null);
            setModelCatalogMessage('');
            setModelCatalogFailed(false);
          }}
          className="settings-input"
          placeholder="sk-..."
        />
        {preset.consoleUrl && (
          <a
            href={preset.consoleUrl}
            target="_blank"
            rel="noreferrer"
            className="settings-hint-link"
          >
            前往 {preset.label} 控制台获取 API Key
          </a>
        )}
      </div>

      <div className="settings-field">
        <label>API 地址（可自定义代理）</label>
        <input
          type="url"
          value={config.baseUrl}
          onChange={e => handleBaseUrlChange(e.target.value)}
          className="settings-input"
          placeholder="https://api.example.com/v1"
        />
        {urlEdited && preset.baseUrl && config.baseUrl.trim() !== preset.baseUrl && (
          <p className="settings-hint">
            已使用自定义地址，切换服务商时不会被覆盖。
            <button onClick={handleResetBaseUrl} className="settings-link-button">
              恢复 {preset.label} 默认地址
            </button>
          </p>
        )}
      </div>

      <div className="settings-field">
        <label>当前模型</label>
        <select
          value={config.model}
          onChange={event => handleModelChange(event.target.value)}
          className="settings-input"
        >
          {selectableModels.map(model => (
            <option key={model} value={model}>{formatModelLabel(model)}</option>
          ))}
        </select>

        {preset.modelListMode ? (
          <div className="settings-model-sync-row">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleLoadModelCatalog}
              disabled={modelCatalogLoading || !config.apiKey.trim() || !config.baseUrl.trim()}
            >
              {modelCatalogLoading ? '读取中...' : '读取账号可用模型'}
            </button>
            {modelCatalogMessage && (
              <span className={modelCatalogFailed ? 'settings-save-error' : 'settings-success'}>
                {modelCatalogMessage}
              </span>
            )}
          </div>
        ) : (
          <p className="settings-hint">
            该服务商暂未提供可安全调用的官方模型列表接口，请使用内置推荐或手工添加模型 ID。
          </p>
        )}

        {syncedModels.length > 0
          && config.model
          && !syncedModels.some(model => model.id === config.model) && (
          <p className="settings-hint">
            当前模型不在本次接口结果中，插件仍会保留它，不会自动删除旧配置或自定义模型。
          </p>
        )}

        <div className="settings-model-add-row">
          <input
            type="text"
            value={newModel}
            onChange={event => setNewModel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleAddModel();
              }
            }}
            className="settings-input"
            placeholder="输入模型 ID，例如 gpt-5.6-terra"
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleAddModel}
            disabled={!newModel.trim()}
          >
            添加并切换
          </button>
        </div>

        <div className="settings-model-list" aria-label="已保存模型">
          {savedModels.map(model => (
            <span key={model} className={model === config.model ? 'settings-model-chip is-active' : 'settings-model-chip'}>
              <button type="button" onClick={() => handleModelChange(model)}>{model}</button>
              <button
                type="button"
                aria-label={`移除模型 ${model}`}
                title={savedModels.length === 1 ? '至少保留一个模型' : '移除模型'}
                onClick={() => handleRemoveModel(model)}
                disabled={savedModels.length === 1}
              >
                ×
              </button>
            </span>
          ))}
        </div>

        <p className="settings-hint">
          可保存多个模型并随时切换；所有 AI 功能统一使用“当前模型”，不会同时请求多个模型。
          推理模型的思考内容会占用输出额度，额度耗尽时会自动回退本地规则解析。
        </p>

        {modelEdited && preset.defaultModel && config.model.trim() !== preset.defaultModel ? (
          <p className="settings-hint">
            已使用自定义模型，切换服务商时不会被覆盖。
            <button onClick={handleResetModel} className="settings-link-button">
              恢复 {preset.defaultModel}
            </button>
          </p>
        ) : (preset.models.length > 0 || (preset.reasoningModels?.length ?? 0) > 0) && (
          <p className="settings-hint">
            内置推荐（校准于 {MODEL_PRESETS_UPDATED_AT}）：
            {[...preset.models, ...(preset.reasoningModels ?? [])].join('、')}。
            账号权限和模型上下架以“读取账号可用模型”的结果为准。
          </p>
        )}

        {preset.reasoningOnly && (
          <p className="settings-hint">
            {preset.label} 目前在售的
            {(preset.reasoningModels ?? []).join('、')} 均为推理模型，
            建议改用支持非思考模式的 DeepSeek（deepseek-v4-flash）、
            Qwen（qwen3.8-flash）或 MiMo（mimo-v2.5）。
          </p>
        )}
      </div>

      {(config.provider === LLMProvider.OPENAI || config.provider === LLMProvider.CUSTOM) && (
        <div className="settings-field">
          <label>调用接口</label>
          <select
            value={config.apiMode ?? LLMApiMode.CHAT_COMPLETIONS}
            onChange={event => setConfig({ ...config, apiMode: event.target.value as LLMApiMode })}
            className="settings-input"
          >
            <option value={LLMApiMode.RESPONSES}>Responses API（OpenAI 官方推荐）</option>
            <option value={LLMApiMode.CHAT_COMPLETIONS}>Chat Completions（兼容旧配置/代理）</option>
          </select>
          <p className="settings-hint">
            新选择 OpenAI 时默认请求 <code>POST /v1/responses</code>；旧配置继续请求
            <code> POST /v1/chat/completions</code>，可在此手动切换。
          </p>
        </div>
      )}

      {config.provider === LLMProvider.CUSTOM && (
        <div className="settings-field">
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              checked={Boolean(config.visionEnabled)}
              onChange={e => setConfig({ ...config, visionEnabled: e.target.checked })}
            />
            启用视觉输入能力
          </label>
          <p className="settings-hint">
            仅当你的自定义 OpenAI 兼容服务实际支持图片输入时再开启。
            当前版本先用它声明该服务是否具备视觉输入能力，后续接入视觉优先框选补填时会据此决定是否允许发送图片请求。
          </p>
        </div>
      )}

      <div className="settings-button-row">
        <button
          onClick={handleTest}
          disabled={testing || !config.apiKey}
          className="btn btn-secondary"
        >
          {testing ? '测试中...' : '测试连接'}
        </button>
        {testResult === 'success' && <span className="settings-success">连接成功</span>}
      </div>

      {testResult === 'fail' && (
        <div className="settings-error">
          <strong>连接失败</strong>
          <p>{errorMsg}</p>
        </div>
      )}

      <div className="options-actions">
        {saveMessage && (
          <span className={saveFailed ? 'settings-save-error' : 'settings-success'}>{saveMessage}</span>
        )}
        <button onClick={handleSave} className="btn btn-primary">
          {saved ? '已保存' : '保存设置'}
        </button>
      </div>
    </div>
  );
}
