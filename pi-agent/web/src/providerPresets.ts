export const providerPresets = [
  {id:"aliyun-bailian", label:"阿里云百炼", url:"https://dashscope.aliyuncs.com/compatible-mode/v1"},
  {id:"deepseek", label:"DeepSeek", url:"https://api.deepseek.com"},
] as const;

/** 选择预设时才填入地址；读取已保存配置不覆盖用户的区域/专用接口。 */
export class ProviderPresetPicker {
  private readonly select: HTMLSelectElement;
  constructor(private readonly provider: HTMLInputElement, private readonly address: HTMLInputElement) {
    this.select = document.createElement("select");
    this.select.id = "provider-preset";
    this.select.setAttribute("aria-label", "模型服务商");
    this.select.innerHTML = '<option value="">选择服务商</option>' + providerPresets.map(p => `<option value="${p.id}">${p.label}</option>`).join("") + '<option value="custom">自定义兼容接口</option>';
    provider.before(this.select);
    provider.placeholder = "自定义服务商名称";
    provider.setAttribute("aria-label", "自定义服务商名称");
    this.select.addEventListener("change", () => {
      const preset = providerPresets.find(p => p.id === this.select.value);
      provider.hidden = Boolean(preset) || !this.select.value;
      if (preset) { provider.value = preset.id; address.value = preset.url; }
      else if (this.select.value === "custom") { provider.hidden = false; provider.focus(); }
      else { provider.hidden = false; provider.value = ""; }
    });
    this.sync();
  }
  sync(): void {
    const preset = providerPresets.find(p => p.id === this.provider.value);
    this.select.value = preset?.id ?? (this.provider.value ? "custom" : "");
    this.provider.hidden = Boolean(preset) || !this.provider.value;
    this.select.required = true;
  }
}
