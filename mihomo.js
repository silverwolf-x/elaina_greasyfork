/*
 * Mihomo Party / Mihomo JavaScript 覆写脚本
 *
 * 目标：
 * 1. 符合 Mihomo Party JavaScript 覆写规则：入口为 main(config)，返回 config。
 * 2. 全局开启 IPv6，并启用 tcp-concurrent。
 * 3. 静态 proxies 和 proxy-providers 仅在缺省时补充 ip-version: ipv6-prefer。
 * 4. 使用 rule-providers 加载远程 pure-v6 规则集。
 * 5. DNS 仅为 pure-v6 规则集追加 IPv6-only nameserver-policy，不覆写其它 DNS 项。
 * 6. 新增 DIRECT-V6仅IPv6 直连节点和前置 RULE-SET，让指定域名连接层只使用 IPv6。
 * 7. 策略组通过组内节点、provider override 和 DIRECT-V6优先 实现常规 IPv6 优先。
 * 8. 新增 DIRECT-V6优先 直连节点，并把规则里的 DIRECT 替换过去。
 * 9. 开启保守域名嗅探，提高 fake-ip / TUN 场景下的分流准确率。
 * 10. 不强制开启 TUN，不默认阻断 QUIC。
 */

const directName = "DIRECT-V6优先";
const directOnlyName = "DIRECT-V6仅IPv6";
const v6RuleProviderName = "pure-v6";
const v6PolicyDomains =
  "https://raw.githubusercontent.com/silverwolf-x/elaina_greasyfork/main/rules/pure-v6.txt";

const v6Dns = [
  "https://doh.pub/dns-query#disable-ipv4=true",
  "https://dns.alidns.com/dns-query#disable-ipv4=true",
];
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
  const currentNameserverPolicy = isPlainObject(dns["nameserver-policy"])
    ? dns["nameserver-policy"]
    : {};
  const v6RuleSet = `rule-set:${v6RuleProviderName}`;

  config.dns = {
    ...dns,
    // 命中 pure-v6 规则集时，只使用 v6Dns；disable-ipv4 会让 A 记录返回空，强制走 AAAA。
    // 除这个 policy 外，不覆写用户已有的 DNS 服务器、fake-ip、hosts、fallback 等配置。
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