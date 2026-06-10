/*
 * Mihomo Party / Mihomo JavaScript 覆写脚本
 *
 * 目标：
 * 1. 符合 Mihomo Party JavaScript 覆写规则：入口为 main(config)，返回 config。
 * 2. 全局开启 IPv6，并启用 tcp-concurrent。
 * 3. DNS 使用 fake-ip 模式。
 * 4. DNS 合并指定 fake-ip 模板。
 * 5. fake-ip-range6 使用 fdfe:dcba:9876::1/64，fake-ip-filter 使用极简 geosite 集合：
 *    - geosite:private
 *    - geosite:category-ntp
 * 6. 静态 proxies 和 proxy-providers 仅在缺省时补充 ip-version: ipv6-prefer。
 * 7. 使用 rule-providers 加载远程 pure-v6 规则集。
 * 8. nameserver-policy / fake-ip-filter 引用同一规则集，并让直连 DNS 遵循 policy。
 * 9. 新增 DIRECT-V6仅IPv6 直连节点和前置 RULE-SET，让指定域名连接层只使用 IPv6。
 * 10. 策略组通过组内节点、provider override 和 DIRECT-V6优先 实现常规 IPv6 优先。
 * 11. 新增 DIRECT-V6优先 直连节点，并把规则里的 DIRECT 替换过去。
 * 12. 开启保守域名嗅探，提高 fake-ip / TUN 场景下的分流准确率。
 * 13. 不强制开启 TUN，不默认阻断 QUIC。
 */

const gatewayDoh = "https://i4cm5lqxfu.cloudflare-gateway.com/dns-query";
const directName = "DIRECT-V6优先";
const directOnlyName = "DIRECT-V6仅IPv6";
const v6RuleProviderName = "pure-v6";
const v6PolicyDomains =
  "https://raw.githubusercontent.com/silverwolf-x/elaina_greasyfork/main/rules/pure-v6.txt";

const v6Dns = [
  "https://doh.pub/dns-query#disable-ipv4=true",
  "https://dns.alidns.com/dns-query#disable-ipv4=true",
];
const fakeIpFilters = ["geosite:private", "geosite:category-ntp"];
const snifferSkipDomains = [
  "Mijia Cloud",
  "dlg.io.mi.com",
  "+.push.apple.com",
];

function main(config) {
  const nextConfig = isPlainObject(config) ? config : {};

  applyGeneralOptions(nextConfig);
  applyProfile(nextConfig);
  applySniffer(nextConfig);
  applyRuleProviders(nextConfig);
  applyDns(nextConfig);
  applyProxies(nextConfig);
  applyProxyProviders(nextConfig);
  applyProxyGroups(nextConfig);
  applyRules(nextConfig);

  return nextConfig;
}

function applyGeneralOptions(config) {
  config.ipv6 = true;
  config["tcp-concurrent"] = true;
}

function applyProfile(config) {
  config.profile = {
    ...(isPlainObject(config.profile) ? config.profile : {}),
    "store-selected": true,
    "store-fake-ip": true,
  };
}

function applySniffer(config) {
  const sniffer = isPlainObject(config.sniffer) ? config.sniffer : {};
  const currentSkipDomains = Array.isArray(sniffer["skip-domain"])
    ? sniffer["skip-domain"]
    : [];

  config.sniffer = {
    ...sniffer,
    enable: true,
    "force-dns-mapping": true,
    "parse-pure-ip": true,
    "override-destination": true,
    sniff: {
      ...(isPlainObject(sniffer.sniff) ? sniffer.sniff : {}),
      HTTP: {
        ports: [80, "8080-8880"],
        "override-destination": true,
      },
      TLS: {
        ports: [443, 8443],
      },
      QUIC: {
        ports: [443, 8443],
      },
    },
    "skip-domain": unique([...currentSkipDomains, ...snifferSkipDomains]),
  };
}

function applyRuleProviders(config) {
  const ruleProviders = isPlainObject(config["rule-providers"])
    ? config["rule-providers"]
    : {};
  const currentV6Provider = isPlainObject(ruleProviders[v6RuleProviderName])
    ? ruleProviders[v6RuleProviderName]
    : {};

  config["rule-providers"] = {
    ...ruleProviders,
    [v6RuleProviderName]: {
      ...currentV6Provider,
      type: "http",
      url: v6PolicyDomains,
      interval: 86400,
      behavior: "domain",
      format: "text",
    },
  };
}

function applyDns(config) {
  const dns = isPlainObject(config.dns) ? config.dns : {};
  const currentFakeIpFilters = Array.isArray(dns["fake-ip-filter"])
    ? dns["fake-ip-filter"]
    : [];
  const currentNameserverPolicy = isPlainObject(dns["nameserver-policy"])
    ? dns["nameserver-policy"]
    : {};
  const v6RuleSet = `rule-set:${v6RuleProviderName}`;

  config.dns = {
    ...dns,
    enable: true,
    ipv6: true,
    "respect-rules": true,

    "enhanced-mode": "fake-ip",
    "fake-ip-range": dns["fake-ip-range"] || "198.18.0.1/16",
    "fake-ip-range6": "fdfe:dcba:9876::1/64",

    // blacklist 是默认逻辑：命中这些集合的域名返回 real-ip，其它继续 fake-ip。
    // 强制 IPv6 的规则集放进这里，避免 A 查询继续返回 198.18.* 假地址。
    "fake-ip-filter-mode": "blacklist",
    "fake-ip-filter": unique([
      ...currentFakeIpFilters,
      ...fakeIpFilters,
      v6RuleSet,
    ]),

    "use-hosts": false,
    "use-system-hosts": false,

    // bootstrap：只用于解析 Cloudflare Gateway DoH 域名本身，避免回落到系统 DNS。
    "default-nameserver": [
      "2606:4700:4700::1111",
      "2606:4700:4700::1001",
      "1.1.1.1",
      "1.0.0.1",
    ],

    // 默认 DNS 包含指定 Cloudflare Gateway，并保留 Cloudflare / Google；
    // 代理节点 DNS 和直连 DNS 包含指定 Cloudflare Gateway，并保留阿里。
    nameserver: [
      gatewayDoh,
      "https://dns.cloudflare.com/dns-query",
      "https://dns.google/dns-query",
    ],
    "proxy-server-nameserver": [
      gatewayDoh,
      "https://dns.alidns.com/dns-query",
    ],
    "direct-nameserver": [
      gatewayDoh,
      "https://dns.alidns.com/dns-query",
    ],
    "direct-nameserver-follow-policy": true,
    fallback: [
      "https://doh.dns.sb/dns-query",
      "https://dns.google/dns-query",
      "https://1.1.1.1/dns-query",
      "https://1.0.0.1/dns-query",
    ],

    // 命中 pure-v6 规则集时，只使用 v6Dns；disable-ipv4 会让 A 记录返回空，强制走 AAAA。
    "nameserver-policy": {
      ...currentNameserverPolicy,
      [v6RuleSet]: v6Dns,
    },
  };
}

function applyProxies(config) {
  const proxies = Array.isArray(config.proxies) ? config.proxies : [];

  config.proxies = proxies.map((proxy) => {
    if (!isPlainObject(proxy)) return proxy;
    if (Object.prototype.hasOwnProperty.call(proxy, "ip-version")) {
      return proxy;
    }

    return {
      ...proxy,
      "ip-version": "ipv6-prefer",
    };
  });

  ensureProxy(config, {
    name: directName,
    type: "direct",
    udp: true,
    "ip-version": "ipv6-prefer",
  });

  ensureProxy(config, {
    name: directOnlyName,
    type: "direct",
    udp: true,
    "ip-version": "ipv6",
  });
}

function applyProxyProviders(config) {
  if (!isPlainObject(config["proxy-providers"])) return;

  for (const provider of Object.values(config["proxy-providers"])) {
    if (!isPlainObject(provider)) continue;

    const override = isPlainObject(provider.override) ? provider.override : {};
    if (Object.prototype.hasOwnProperty.call(override, "ip-version")) {
      provider.override = override;
      continue;
    }

    provider.override = {
      ...override,
      "ip-version": "ipv6-prefer",
    };
  }
}

function applyProxyGroups(config) {
  if (!Array.isArray(config["proxy-groups"])) return;

  config["proxy-groups"] = config["proxy-groups"].map((group) => {
    if (!isPlainObject(group)) return group;

    return {
      ...group,
      proxies: Array.isArray(group.proxies)
        ? group.proxies.map((name) => (name === "DIRECT" ? directName : name))
        : group.proxies,
    };
  });
}

function applyRules(config) {
  const existingRules = Array.isArray(config.rules) ? config.rules : [];
  const v6RouteRule = `RULE-SET,${v6RuleProviderName},${directOnlyName}`;

  config.rules = unique([v6RouteRule, ...existingRules]).map((rule) => {
    if (typeof rule !== "string") return rule;

    return rule.replace(/,DIRECT(,|$)/, `,${directName}$1`);
  });
}

function ensureProxy(config, proxy) {
  if (!config.proxies.some((item) => item && item.name === proxy.name)) {
    config.proxies.push(proxy);
  }
}

function unique(items) {
  return Array.from(new Set(items));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}