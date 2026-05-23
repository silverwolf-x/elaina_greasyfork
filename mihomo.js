/*
 * Mihomo Party / Mihomo JavaScript 覆写脚本
 *
 * 目标：
 * 1. 全局开启 IPv6，并启用 tcp-concurrent。
 * 2. DNS 使用 fake-ip 模式。
 * 3. fake-ip-filter 精简为 geosite 集合：
 *    - geosite:private
 *    - geosite:category-ntp
 * 4. 所有静态 proxies 节点添加 ip-version: ipv6-prefer。
 * 5. 所有 proxy-providers 通过 override 添加 ip-version: ipv6-prefer。
 * 6. 新增 DIRECT-V6优先 直连节点。
 * 7. 强制把策略组和规则里的 DIRECT 替换为 DIRECT-V6优先。
 * 8. 默认阻断 UDP/443，也就是 QUIC/HTTP3。
 */

function main(config) {
  const doh = "https://i4cm5lqxfu.cloudflare-gateway.com/dns-query";
  const directName = "DIRECT-V6优先";

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

  // TUN 配置
  config.tun = {
    ...(config.tun || {}),
    enable: true,
    stack: "mixed",
    "auto-route": true,
    "auto-redirect": true,
    "auto-detect-interface": true,
    "dns-hijack": ["any:53", "tcp://any:53"],
  };

  // DNS：fake-ip + geosite 精简过滤
  config.dns = {
    enable: true,
    listen: "0.0.0.0:1053",
    ipv6: true,

    "enhanced-mode": "fake-ip",
    "fake-ip-range": "198.18.0.1/16",
    "fake-ip-range6": "fdfe:dcba:9876::1/64",

    // blacklist 是默认逻辑：命中这些集合的域名返回 real-ip，其它继续 fake-ip
    "fake-ip-filter-mode": "blacklist",
    "fake-ip-filter": [
      "geosite:private",
      "geosite:category-ntp",
    ],

    // bootstrap：只用于解析 Cloudflare Gateway DoH 域名本身
    "default-nameserver": [
      "2606:4700:4700::1111",
      "2606:4700:4700::1001",
      "1.1.1.1",
      "1.0.0.1",
    ],

    // 实际 DNS / 代理节点 DNS / 直连 DNS 全部只用这个 DoH
    nameserver: [doh],
    "proxy-server-nameserver": [doh],
    "direct-nameserver": [doh],
    "direct-nameserver-follow-policy": false,

    "use-hosts": false,
    "use-system-hosts": false,

    // 清空原配置里的 DNS 分流和 fallback
    "nameserver-policy": {},
    fallback: [],
  };

  // 静态节点：全部设置 IPv6 优先
  config.proxies = Array.isArray(config.proxies) ? config.proxies : [];

  config.proxies = config.proxies.map((proxy) => {
    if (!proxy || typeof proxy !== "object") return proxy;

    return {
      ...proxy,
      "ip-version": "ipv6-prefer",
    };
  });

  // 新增一个 IPv6 优先的 DIRECT 节点
  if (!config.proxies.some((proxy) => proxy && proxy.name === directName)) {
    config.proxies.push({
      name: directName,
      type: "direct",
      udp: true,
      "ip-version": "ipv6-prefer",
    });
  }

  // proxy-providers：全部通过 override 设置 IPv6 优先
  if (
    config["proxy-providers"] &&
    typeof config["proxy-providers"] === "object"
  ) {
    for (const providerName of Object.keys(config["proxy-providers"])) {
      const provider = config["proxy-providers"][providerName];
      if (!provider || typeof provider !== "object") continue;

      provider.override = {
        ...(provider.override || {}),
        "ip-version": "ipv6-prefer",
      };
    }
  }

  // 策略组：强制把内置 DIRECT 替换成 DIRECT-V6优先
  if (Array.isArray(config["proxy-groups"])) {
    config["proxy-groups"] = config["proxy-groups"].map((group) => {
      if (!group || typeof group !== "object") return group;
      if (!Array.isArray(group.proxies)) return group;

      return {
        ...group,
        proxies: group.proxies.map((name) =>
          name === "DIRECT" ? directName : name
        ),
      };
    });
  }

  // 规则：强制把目标为 DIRECT 的规则替换成 DIRECT-V6优先
  if (Array.isArray(config.rules)) {
    config.rules = config.rules.map((rule) => {
      if (typeof rule !== "string") return rule;

      return rule.replace(/,DIRECT(,|$)/, `,${directName}$1`);
    });

    // 拒绝 UDP/443，也就是常见 QUIC/HTTP3
    const quicRejectRule = "AND,((NETWORK,UDP),(DST-PORT,443)),REJECT";
    if (!config.rules.includes(quicRejectRule)) {
      config.rules.unshift(quicRejectRule);
    }
  }

  return config;
}