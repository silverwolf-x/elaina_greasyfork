/*
 * Mihomo Party / Mihomo JavaScript 覆写脚本
 *
 * 目标：
 * 1. 符合 Mihomo Party JavaScript 覆写规则：入口为 main(config)，返回 config。
 * 2. 全局开启 IPv6，并启用 tcp-concurrent。
 * 3. DNS 使用 fake-ip 模式。
 * 4. DNS 合并 linux.do 极简 fake-ip 模板，并加入指定 Cloudflare Gateway DoH。
 * 5. fake-ip-range6 使用 fdfe:dcba:9876::1/64，fake-ip-filter 使用极简 geosite 集合：
 *    - geosite:private
 *    - geosite:category-ntp
 * 6. 静态 proxies 和 proxy-providers 仅在缺省时补充 ip-version: ipv6-prefer。
 * 7. 策略组通过组内节点、provider override 和 DIRECT-V6优先 实现 IPv6 优先。
 * 8. 新增 DIRECT-V6优先 直连节点，并把规则里的 DIRECT 替换过去。
 * 9. 开启保守域名嗅探，提高 fake-ip / TUN 场景下的分流准确率。
 * 10. 不强制开启 TUN，不默认阻断 QUIC。
 */

function main(config) {
  const gatewayDoh = "https://i4cm5lqxfu.cloudflare-gateway.com/dns-query";
  const directName = "DIRECT-V6优先";
  const fakeIpFilters = ["geosite:private", "geosite:category-ntp"];
  const snifferSkipDomains = [
    "Mijia Cloud",
    "dlg.io.mi.com",
    "+.push.apple.com",
  ];

  // 全局 IPv6
  config.ipv6 = true;

  // TCP 并发连接，有助于双栈连接择优
  config["tcp-concurrent"] = true;

  // 保存选择与 fake-ip 映射
  config.profile = {
    ...(config.profile || {}),
    "store-selected": true,
    "store-fake-ip": true,
  };

  // 域名嗅探：参考 Mihomo 官方示例和常见配置，作为 fake-ip / TUN 的分流兜底。
  const sniffer =
    config.sniffer && typeof config.sniffer === "object"
      ? config.sniffer
      : {};
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
      ...(sniffer.sniff || {}),
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
    "skip-domain": Array.from(
      new Set([...currentSkipDomains, ...snifferSkipDomains])
    ),
  };

  // DNS：合并 linux.do 极简 fake-ip 模板，并保留 IPv6 fake-ip 地址池。
  const dns = config.dns && typeof config.dns === "object" ? config.dns : {};
  const currentFakeIpFilters = Array.isArray(dns["fake-ip-filter"])
    ? dns["fake-ip-filter"]
    : [];

  config.dns = {
    ...dns,
    enable: true,
    ipv6: true,
    "respect-rules": true,

    "enhanced-mode": "fake-ip",
    "fake-ip-range": dns["fake-ip-range"] || "198.18.0.1/16",
    "fake-ip-range6": "fdfe:dcba:9876::1/64",

    // blacklist 是默认逻辑：命中这些集合的域名返回 real-ip，其它继续 fake-ip
    "fake-ip-filter-mode": "blacklist",
    "fake-ip-filter": Array.from(
      new Set([...currentFakeIpFilters, ...fakeIpFilters])
    ),

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
  };

  // 静态节点：仅在缺省时补充 IPv6 优先，尊重订阅里已有的 ip-version。
  config.proxies = Array.isArray(config.proxies) ? config.proxies : [];
  config.proxies = config.proxies.map((proxy) => {
    if (!proxy || typeof proxy !== "object") return proxy;
    if (Object.prototype.hasOwnProperty.call(proxy, "ip-version")) {
      return proxy;
    }

    return {
      ...proxy,
      "ip-version": "ipv6-prefer",
    };
  });

  // 新增一个 IPv6 优先的 DIRECT 节点，用于替换内置 DIRECT。
  if (!config.proxies.some((proxy) => proxy && proxy.name === directName)) {
    config.proxies.push({
      name: directName,
      type: "direct",
      udp: true,
      "ip-version": "ipv6-prefer",
    });
  }

  // proxy-providers：仅在缺省时通过 override 补充 IPv6 优先。
  if (
    config["proxy-providers"] &&
    typeof config["proxy-providers"] === "object"
  ) {
    for (const providerName of Object.keys(config["proxy-providers"])) {
      const provider = config["proxy-providers"][providerName];
      if (!provider || typeof provider !== "object") continue;

      const override =
        provider.override && typeof provider.override === "object"
          ? provider.override
          : {};

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

  // 策略组：不写入 proxy-groups 不支持的 ip-version；
  // 通过组内节点 / provider override / DIRECT-V6优先 实现分组流量 IPv6 优先。
  if (Array.isArray(config["proxy-groups"])) {
    config["proxy-groups"] = config["proxy-groups"].map((group) => {
      if (!group || typeof group !== "object") return group;

      return {
        ...group,
        proxies: Array.isArray(group.proxies)
          ? group.proxies.map((name) =>
              name === "DIRECT" ? directName : name
            )
          : group.proxies,
      };
    });
  }

  // 规则：把目标为 DIRECT 的规则替换成 IPv6 优先直连节点。
  if (Array.isArray(config.rules)) {
    config.rules = config.rules.map((rule) => {
      if (typeof rule !== "string") return rule;

      return rule.replace(/,DIRECT(,|$)/, `,${directName}$1`);
    });
  }

  return config;
}