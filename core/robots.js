// robots.txt를 읽고 "이 주소를 받아가도 된다고 했나"를 봅니다.
//
// 규칙이 몇 줄 안 되지만 헷갈리는 구석이 있어 여기 적어둡니다(RFC 9309).
//  - 그룹은 User-agent로 고릅니다. **가장 길게 일치하는 이름 하나**만 적용되고, 없으면 `*`.
//    여러 그룹이 섞여 적용되지 않습니다.
//  - 한 그룹 안에서는 **경로가 가장 긴 규칙**이 이깁니다. 길이가 같으면 Allow가 이깁니다.
//  - 빈 Disallow는 "전부 허용"입니다. 빈 Allow는 규칙이 아닙니다.
//  - `*`는 아무 글자, `$`는 끝을 뜻합니다.
//  - robots.txt가 없으면(404) 제한이 없는 것으로 봅니다. 받지 못했으면(5xx·차단) **모릅니다** —
//    모르는 것을 허용으로 치지 않습니다.

/** 한 줄씩 읽어 그룹으로 묶습니다. 주석과 알 수 없는 줄은 버립니다. */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let agentsOpen = false;

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const at = line.indexOf(':');
    if (at < 0) continue;
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();

    if (field === 'sitemap') { sitemaps.push(value); continue; }

    if (field === 'user-agent') {
      // 연달아 적힌 User-agent는 한 그룹입니다. 규칙이 한 번 나온 뒤의 것은 새 그룹입니다.
      if (!current || !agentsOpen) { current = { agents: [], rules: [], crawlDelay: null }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      agentsOpen = true;
      continue;
    }
    if (!current) continue;          // 그룹 밖의 규칙은 버립니다
    agentsOpen = false;

    if (field === 'allow' || field === 'disallow') {
      if (field === 'disallow' && value === '') { current.rules.push({ allow: true, path: '/' }); continue; }
      if (value === '') continue;    // 빈 Allow는 규칙이 아닙니다
      current.rules.push({ allow: field === 'allow', path: value });
    } else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) current.crawlDelay = seconds;
    }
  }
  return { groups, sitemaps };
}

/** 우리에게 적용되는 그룹 하나. 이름이 가장 길게 일치하는 것, 없으면 `*`. */
export function groupFor({ groups }, userAgent) {
  const ua = String(userAgent ?? '').toLowerCase();
  let best = null;
  let bestLength = -1;
  for (const group of groups) {
    for (const agent of group.agents) {
      const match = agent === '*' ? 0 : (ua.includes(agent) ? agent.length : -1);
      if (match > bestLength) { best = group; bestLength = match; }
    }
  }
  return best;
}

/** robots의 경로 무늬를 정규식으로. `*`는 아무 글자, `$`는 끝. */
function toPattern(path) {
  const escaped = path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + (escaped.endsWith('\\$') ? escaped.slice(0, -2) + '$' : escaped));
}

/**
 * 그 경로를 받아가도 되나. 돌려주는 `rule`은 판단의 근거입니다 — 문서에 그대로 적으려고요.
 * 규칙이 하나도 안 맞으면 허용입니다(robots는 금지 목록입니다).
 */
export function isAllowed(robots, userAgent, path) {
  const group = groupFor(robots, userAgent);
  if (!group) return { allowed: true, rule: null, crawlDelay: null };

  let best = null;
  for (const rule of group.rules) {
    if (!toPattern(rule.path).test(path)) continue;
    // 긴 규칙이 이기고, 길이가 같으면 Allow가 이깁니다.
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) {
      best = rule;
    }
  }
  return { allowed: best ? best.allow : true, rule: best, crawlDelay: group.crawlDelay };
}
