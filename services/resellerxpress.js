const axios = require("axios");
const AdminSetting = require("../models/AdminSetting");
const datamart = require("./datamart");
const remadata = require("./remadata");
const { getBundles: getRemaDataBundles, buyData: buyRemaData, isConfigured: isRemaDataConfigured } = remadata;
const { getConfiguredSmsFee, getSmsPricing } = require("./sendcomms");

let handlingFees = { mtn: 1, telecel: 1, airteltigo: 1 };
let selectedProvider = "";

function getBaseUrl() {
  return process.env.RESSELLERXPRESS_BASE_URL || "https://resellerxpress.shop/api/v1";
}

function getApiKey() {
  return process.env.RESSELLERXPRESS_API_KEY || "";
}

function configurePricingRules(settings = {}) {
  if (settings.handlingFees && typeof settings.handlingFees === "object") {
    handlingFees = Object.fromEntries(Object.entries(settings.handlingFees)
      .filter(([, value]) => Number.isFinite(Number(value)) && Number(value) >= 0)
      .map(([network, value]) => [normalizeNetwork(network), Number(value)]));
  }
  if (["", "resellerxpress", "remadata", "datamart"].includes(String(settings.selectedProvider ?? ""))) {
    selectedProvider = String(settings.selectedProvider ?? "");
  }
}

async function loadPricingRules() {
  try {
    const records = await AdminSetting.find({ key: { $in: ["handlingFees", "selectedProvider"] } }).lean();
    configurePricingRules(Object.fromEntries(records.map((record) => [record.key, record.value])));
  } catch (error) {
    // Environment defaults remain active when the database is unavailable.
  }
}

function isConfigured() {
  return Boolean(getApiKey());
}

function getHeaders() {
  return {
    "X-API-KEY": getApiKey(),
    "Content-Type": "application/json"
  };
}

function getFallbackPlans(network) {
  const normalized = normalizeNetwork(network) || "mtn";
  const volumeTiers = [1, 2, 3, 5, 7, 10, 15, 20, 30, 50];
  const basePrices = {
    mtn: [4, 7, 10, 15, 20, 30, 42, 54, 78, 125],
    airteltigo: [4, 7, 10, 15, 20, 29, 40, 52, 75, 120],
    telecel: [4, 7, 10, 15, 20, 29, 40, 52, 75, 120]
  };
  const names = { mtn: "MTN", airteltigo: "ATgo", telecel: "Telecel" };
  const samples = Object.fromEntries(Object.entries(basePrices).map(([providerNetwork, prices]) => [
    providerNetwork,
    volumeTiers.map((volumeGb, index) => {
      const price = prices[index];
      const idNetwork = providerNetwork === "airteltigo" ? "atgo" : providerNetwork;
      return {
        id: `fallback-${idNetwork}-${volumeGb}gb`,
        provider: "resellerxpress",
        name: `${volumeGb}GB ${names[providerNetwork]} Bundle`,
        network: providerNetwork,
        volume: `${volumeGb}GB`,
        volumeGb,
        price,
        fee: 0.50,
        total: price + 0.50,
        amount: price,
        available: true,
        feeKnown: true,
        feeSource: "fallback"
        ,purchasable: false
      };
    })
  ]));

  return (samples[normalized] || samples.mtn).map((plan) => {
    const pricing = calculateSellingPrice(plan.price, plan.volumeGb, plan.network);
    const smsPricing = addSmsPricing({ volumeGb: plan.volumeGb, network: plan.network }, plan.price);
    if (!smsPricing) return null;
    return {
      ...plan,
      cost: plan.price,
      smsFee: 0,
      sellingPrice: smsPricing.sellingPrice || pricing?.sellingPrice,
      expectedProfit: smsPricing.expectedProfit || pricing?.expectedProfit
    };
  }).filter(Boolean);
}

function calculateSellingPrice(totalCost, volumeGb, network) {
  const cost = Number(totalCost);
  const volume = Number(volumeGb);
  if (!Number.isFinite(cost) || cost <= 0) return null;
  const feePerGb = Number(handlingFees[normalizeNetwork(network)] ?? 1);
  const fee = feePerGb * (Number.isFinite(volume) && volume > 0 ? volume : 1);
  return { sellingPrice: Number((cost + fee).toFixed(2)), expectedProfit: fee };
}

function addSmsPricing(pricing, totalCost, smsFee = getConfiguredSmsFee()) {
  const adjusted = calculateSellingPrice(Number(totalCost), pricing.volumeGb, pricing.network);
  return adjusted ? { ...adjusted, smsFee: 0 } : null;
}

function normalizeNetwork(network) {
  if (!network) return null;

  const value = String(network).trim().toLowerCase();

  if (value.includes("mtn")) return "mtn";
  if (value.includes("airteltigo") || value.includes("atgo")) return "airteltigo";
  if (value.includes("telecel")) return "telecel";

  return value;
}

function normalizePlanRecord(plan, network, provider) {
  const hasFee = ["fee", "handling_fee", "service_fee", "processing_fee"].some((key) => plan[key] !== undefined && plan[key] !== null);
  const price = Number(plan.price?.amount ?? plan.price ?? plan.api_price ?? plan.amount ?? plan.total ?? plan.sell_price ?? plan.provider_price?.amount ?? 0);
  const fee = hasFee
    ? Number(plan.fee ?? plan.handling_fee ?? plan.service_fee ?? plan.processing_fee)
    : DEFAULT_PROVIDER_FEE;
  const total = hasFee ? Number(plan.total ?? price + fee) : price + fee;
  const normalizedNetwork = normalizeNetwork(plan.network || network || "mtn");
  const rawVolume = plan.volume_gb ?? plan.capacity_gb ?? plan.volume ?? plan.volume_mb ?? plan.volumeInMB ?? plan.capacity_mb ?? plan.capacity ?? plan.bundle_size ?? plan.data_size ?? plan.name;
  const volumeText = String(rawVolume ?? "").trim().toLowerCase();
  const volumeNumber = Number(volumeText.replace(/[^0-9.]/g, ""));
  const volumeGb = plan.volume_gb !== undefined || plan.capacity_gb !== undefined || volumeText.includes("gb")
    ? volumeNumber
    : plan.volume_mb !== undefined || plan.volumeInMB !== undefined || plan.capacity_mb !== undefined || volumeText.includes("mb")
      ? volumeNumber / 1024
      : volumeNumber;
  const stableId = `${provider || "provider"}:${normalizedNetwork}:${volumeGb}`;

  return {
    ...plan,
    id: plan.id ?? plan.plan_id ?? plan.slug ?? stableId,
    name: plan.name ?? plan.plan_name ?? plan.bundle_name ?? `${plan.volume ?? plan.volume_mb ?? plan.capacity ?? "Bundle"}`,
    network: normalizedNetwork,
    volume: rawVolume ?? plan.data_size ?? plan.name ?? "Bundle",
    volumeGb,
    price,
    fee,
    total,
    amount: price,
    available: ![false, "false", "inactive", "disabled", "out_of_stock", "unavailable"].includes(plan.available)
      && ![false, "false", "inactive", "disabled", "out_of_stock", "unavailable"].includes(plan.status)
      && plan.in_stock !== false && plan.stock !== false,
    feeKnown: true,
    feeSource: hasFee ? "provider" : "configured_default",
    provider: provider || plan.provider || "resellerxpress"
  };
}

async function getResellerPlans(network) {
  const normalizedNetwork = normalizeNetwork(network);

  if (!isConfigured()) {
    return [];
  }

  try {
    const response = await axios.get(`${getBaseUrl()}/plans`, {
      params: normalizedNetwork ? { network: normalizedNetwork } : {},
      headers: getHeaders(),
      timeout: 2500
    });

    const rawPlans = Array.isArray(response.data)
      ? response.data
      : Array.isArray(response.data?.data)
        ? response.data.data
        : Array.isArray(response.data?.plans)
          ? response.data.plans
          : Array.isArray(response.data?.result)
            ? response.data.result
            : [];

    if (rawPlans.length === 0) {
      return [];
    }

    return rawPlans.map((plan) => normalizePlanRecord(plan, normalizedNetwork || network, "resellerxpress"));
  } catch (error) {
    console.warn("ResellerXpress API failed; provider marked unavailable:", error.message);
    return [];
  }
}

async function getRemaDataPlans(network) {
  const normalizedNetwork = normalizeNetwork(network);

  if (!isRemaDataConfigured()) {
    return [];
  }

  try {
    const response = await getRemaDataBundles(normalizedNetwork || network);

    const rawPlans = Array.isArray(response)
      ? response
      : Array.isArray(response?.data)
        ? response.data
        : Array.isArray(response?.data?.bundles)
          ? response.data.bundles
          : Array.isArray(response?.bundles)
            ? response.bundles
        : Array.isArray(response?.plans)
          ? response.plans
          : Array.isArray(response?.result)
            ? response.result
            : [];

    return rawPlans.map((plan) => normalizePlanRecord(plan, normalizedNetwork || network, "remadata"));
  } catch (error) {
    console.warn("RemaData API failed, skipping provider:", error.message);
    return [];
  }
}

async function getSendCommsPlans(network) {
  return [];
}

async function getDataMartPlans(network) {
  if (!datamart.isConfigured()) return [];
  try {
    return (await datamart.getBundles(network)).map((plan) => normalizePlanRecord(plan, network, "datamart"));
  } catch (error) {
    console.warn("DataMart API failed, skipping provider:", error.message);
    return [];
  }
}

async function getPlans(network, options = {}) {
  await loadPricingRules();
  const normalizedNetwork = normalizeNetwork(network) || network || "mtn";

  const requestedProvider = selectedProvider && options.ignoreProviderSelection !== true ? selectedProvider : "";
  if (requestedProvider === "remadata") {
    const remaPlans = await getRemaDataPlans(normalizedNetwork);
    return buildVisiblePlans(await markProviderWalletAvailability(remaPlans), normalizedNetwork, getConfiguredSmsFee(), options);
  }
  if (requestedProvider === "datamart") {
    const datamartPlans = await getDataMartPlans(normalizedNetwork);
    return buildVisiblePlans(await markProviderWalletAvailability(datamartPlans), normalizedNetwork, getConfiguredSmsFee(), options);
  }
  if (requestedProvider === "resellerxpress") {
    const resellerPlans = await getResellerPlans(normalizedNetwork);
    return buildVisiblePlans(await markProviderWalletAvailability(resellerPlans), normalizedNetwork, getConfiguredSmsFee(), options);
  }

  const smsPricing = await getSmsPricing();

  const [resellerPlansResult, remadataPlansResult, datamartPlansResult] = await Promise.allSettled([
    getResellerPlans(normalizedNetwork),
    getRemaDataPlans(normalizedNetwork),
    getDataMartPlans(normalizedNetwork)
  ]);

  const resellerPlans = resellerPlansResult.status === "fulfilled" ? resellerPlansResult.value : [];
  const remadataPlans = remadataPlansResult.status === "fulfilled" ? remadataPlansResult.value : [];
  const datamartPlans = datamartPlansResult.status === "fulfilled" ? datamartPlansResult.value : [];

  const combined = [...resellerPlans, ...remadataPlans, ...datamartPlans];

  return buildVisiblePlans(await markProviderWalletAvailability(combined), normalizedNetwork, smsPricing.fee, options);
}

function buildVisiblePlans(combined, normalizedNetwork, smsFee, options = {}) {
  const uniquePlans = [];
  const seen = new Set();

  combined.forEach((plan) => {
    const uniqueKey = `${plan.provider || "provider"}:${plan.id || plan.name}:${plan.volume || plan.name}:${plan.network || normalizedNetwork}`;

    if (seen.has(uniqueKey)) {
      return;
    }

    seen.add(uniqueKey);
    if (!Number.isFinite(Number(plan.volumeGb)) || Number(plan.volumeGb) < 1) {
      return;
    }
    if (!plan.feeKnown || !Number.isFinite(Number(plan.total)) || Number(plan.total) <= 0) {
      if (options.includeUnavailable && plan.available === false) {
        uniquePlans.push({ ...plan, sellingPrice: 0, expectedProfit: 0, purchasable: false });
      }
      return;
    }

    if (plan.available === false) {
      if (options.includeUnavailable) uniquePlans.push({ ...plan, sellingPrice: 0, expectedProfit: 0, purchasable: false });
      return;
    }

    const pricing = addSmsPricing({ volumeGb: plan.volumeGb, network: plan.network }, Number(plan.price), smsFee);
    if (!pricing) {
      const visibleCost = Number((Number(plan.total) + Number(smsFee || 0)).toFixed(2));
      uniquePlans.push({
        ...plan,
        cost: Number(plan.price),
        smsFee: 0,
        sellingPrice: visibleCost,
        expectedProfit: 0,
        purchasable: true,
        pricingWarning: "Displayed at provider cost because the configured price cap would make this bundle unavailable."
      });
      return;
    }

    uniquePlans.push({
      ...plan,
      total: Number(plan.total || 0),
      price: Number(plan.price || 0),
      fee: Number(plan.fee || 0),
      cost: Number(plan.price),
      smsFee: 0,
      sellingPrice: pricing.sellingPrice,
      purchasable: true,
      expectedProfit: pricing.expectedProfit
    });
  });

  if (uniquePlans.length === 0) {
    return getFallbackPlans(normalizedNetwork).map((plan) => ({
      ...plan,
      ...(options.includeUnavailable ? { available: false, purchasable: false, sellingPrice: 0 } : {}),
      cost: Number(plan.total || 0),
      price: Number(plan.price || 0),
      fee: Number(plan.fee || 0),
      sellingPrice: options.includeUnavailable ? 0 : Number(plan.sellingPrice || plan.price || 0),
      expectedProfit: Number(plan.expectedProfit || 0)
    }));
  }

  const providerFiltered = selectedProvider && options.ignoreProviderSelection !== true
    ? uniquePlans.filter((plan) => plan.provider === selectedProvider)
    : uniquePlans;

  if (options.includeUnavailable) {
    const knownVolumes = new Set(providerFiltered.map((plan) => Number(plan.volumeGb).toFixed(3)));
    [1, 2, 3, 5, 10].forEach((volumeGb) => {
      if (knownVolumes.has(volumeGb.toFixed(3))) return;
      providerFiltered.push({
        id: `out-of-stock-${normalizedNetwork}-${volumeGb}gb`,
        name: `${volumeGb < 1 ? Math.round(volumeGb * 1024) + "MB" : volumeGb + "GB"} ${normalizedNetwork} Bundle`,
        network: normalizedNetwork,
        provider: selectedProvider || "provider",
        volume: `${volumeGb}GB`,
        volumeGb,
        price: 0,
        total: 0,
        cost: 0,
        sellingPrice: 0,
        expectedProfit: 0,
        available: false,
        purchasable: false,
        feeKnown: true
      });
    });
  }

  if (options.allProviders) return providerFiltered.sort((a, b) => a.total - b.total);

  const cheapestByBundle = new Map();
  providerFiltered.forEach((plan) => {
    const volumeGb = Number(plan.volumeGb);
    if (!Number.isFinite(volumeGb) || volumeGb <= 0) return;
    const key = `${plan.network}:${volumeGb}`;
    const current = cheapestByBundle.get(key);
    if (!current || plan.total < current.total) cheapestByBundle.set(key, { ...plan, volumeGb });
  });

  return [...cheapestByBundle.values()].sort((a, b) => a.total - b.total);
}

async function markProviderWalletAvailability(plans) {
  const services = { resellerxpress: module.exports, remadata, datamart };
  const providers = [...new Set(plans.map((plan) => plan.provider))]
    .filter((provider) => services[provider]?.isConfigured?.());
  const balances = await Promise.all(providers.map(async (provider) => {
    try {
      const value = await services[provider].getWalletBalance();
      const amount = Number(value?.balance ?? value?.data?.balance?.balance ?? value?.data?.balance);
      return [provider, Number.isFinite(amount) ? amount : null];
    } catch (error) {
      return [provider, null];
    }
  }));
  const balanceByProvider = new Map(balances);
  return plans.map((plan) => {
    const balance = balanceByProvider.get(plan.provider);
    if (balance === null || balance === undefined) return plan;
    const required = Number(plan.total || plan.cost || plan.price || 0);
    return balance >= required ? plan : { ...plan, available: false, purchasable: false };
  });
}

async function placeProviderOrder(provider, input = {}) {
  const normalizedProvider = String(provider || "").toLowerCase();
  const volumeGb = Number(input.volumeGb || input.volume || 0);

  if (normalizedProvider === "resellerxpress") {
    return placeOrder(input);
  }

  if (!Number.isFinite(volumeGb) || volumeGb <= 0) {
    throw new Error("A valid bundle volume is required for this provider");
  }

  const providerInput = {
    ref: input.request_id,
    phone: input.phone,
    volumeInMB: volumeGb * 1024,
    networkType: input.network
  };

  if (normalizedProvider === "remadata") return buyRemaData(providerInput);
  if (normalizedProvider === "datamart") return datamart.buyData({
    phone: input.phone,
    network: input.network,
    volumeGb,
    capacity: input.capacity || volumeGb,
    requestId: input.request_id
  });

  throw new Error(`Unsupported provider: ${provider}`);
}

async function placeOrder(input = {}) {
  const planId = input.plan_id ?? input.planId;
  const phone = input.phone ?? input.phoneNumber;
  const quantity = Number(input.quantity ?? 1);
  const requestId = input.request_id ?? input.requestId ?? `WIMPS_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (!isConfigured()) {
    throw new Error("ResellerXpress provider is not configured");
  }

  if (!planId) {
    throw new Error("A valid plan_id is required for ResellerXpress orders");
  }

  if (!phone) {
    throw new Error("A recipient phone number is required for ResellerXpress orders");
  }

  const payload = {
    plan_id: Number(planId),
    phone,
    request_id: requestId,
    quantity: Number.isFinite(quantity) && quantity > 0 ? Math.min(quantity, 10) : 1
  };

  try {
    const response = await axios.post(`${getBaseUrl()}/place-order`, payload, {
      headers: getHeaders()
    });

    return response.data;
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || "ResellerXpress order failed");
  }
}

async function getOrderStatus(requestId) {
  if (!isConfigured()) {
    throw new Error("ResellerXpress API key is not configured");
  }

  if (!requestId) {
    throw new Error("request_id is required");
  }

  const response = await axios.get(`${getBaseUrl()}/order-status`, {
    params: { request_id: requestId },
    headers: getHeaders()
  });

  return response.data;
}

async function getOrders(filters = {}) {
  if (!isConfigured()) {
    throw new Error("ResellerXpress API key is not configured");
  }

  const response = await axios.get(`${getBaseUrl()}/orders`, {
    params: {
      ...filters,
      network: normalizeNetwork(filters.network)
    },
    headers: getHeaders()
  });

  return response.data;
}

async function getWalletBalance() {
  if (!isConfigured()) {
    throw new Error("ResellerXpress API key is not configured");
  }

  const response = await axios.get(`${getBaseUrl()}/wallet-balance`, {
    headers: getHeaders()
  });

  return response.data;
}

async function getReprocessable() {
  if (!isConfigured()) {
    throw new Error("ResellerXpress API key is not configured");
  }

  const response = await axios.get(`${getBaseUrl()}/reprocessable`, {
    headers: getHeaders()
  });

  return response.data;
}

async function reprocessOrder(id) {
  if (!isConfigured()) {
    throw new Error("ResellerXpress API key is not configured");
  }

  if (!id) {
    throw new Error("Order id is required for reprocessing");
  }

  const response = await axios.post(`${getBaseUrl()}/reprocess/${id}`, {}, {
    headers: getHeaders()
  });

  return response.data;
}

async function setWebhook(url, enabled, events) {
  if (!isConfigured()) {
    throw new Error("ResellerXpress API key is not configured");
  }

  if (!url || enabled === undefined || !Array.isArray(events)) {
    throw new Error("url, enabled, and events are required");
  }

  const response = await axios.post(`${BASE_URL}/webhook`, {
    url,
    enabled,
    events
  }, {
    headers: getHeaders()
  });

  return response.data;
}

module.exports = {
  isConfigured,
  getFallbackPlans,
  getPlans,
  placeOrder,
  placeProviderOrder,
  getOrderStatus,
  getOrders,
  getWalletBalance,
  getReprocessable,
  reprocessOrder,
  setWebhook,
  calculateSellingPrice,
  configurePricingRules,
};
