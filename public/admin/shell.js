// public/admin/shell.js
// 管理画面の共通シェル（左サイドバー・上部バー）。2026-10-27 新設（UI刷新・段階1）。
//
// 各ページは <body data-page="..."> の直後でこのファイルを読み込む（同期実行。
// ページ本文より先にサイドバーを挿入するため、表示のちらつきが出ない）。
// ナビ項目はこのファイルの NAV に1箇所だけ定義する。
// ui.css を読み込む移行済みページ専用。未移行ページ（common.css）では読み込まない。
//
// 上部バーの記録状態チップは、各ページが取得済みの試合一覧から
// AdminShell.setRecordStatus(events) を呼んで更新する（シェル自身は API を呼ばない）。
(function () {
  // page: <body data-page> の値。hash: 同一ページ内セクションへのリンク（現在地の判定に使う）。
  const NAV = [
    { group: '運営', items: [
      { label: 'ダッシュボード', href: 'index.html', page: 'index' },
      { label: '試合管理', href: 'events.html', page: 'events' },
      { label: '対抗戦ペア', href: 'events.html#battles', page: 'events', hash: '#battles' },
      { label: 'デモモード', href: 'events.html#demo', page: 'events', hash: '#demo' },
      { label: '順位確定', href: 'ranking-control.html', page: 'ranking' },
    ] },
    { group: 'マスタ', items: [
      { label: 'チーム・ジャンル', href: 'masters.html', page: 'masters' },
      { label: 'デバイス', href: 'masters.html#devices', page: 'masters', hash: '#devices' },
      { label: '選手・推し対象', href: 'targets.html', page: 'targets' },
    ] },
  ];

  const currentPage = document.body.getAttribute('data-page') || '';

  function isActive(item) {
    if (item.page !== currentPage) return false;
    const hasHashItem = NAV.some((g) => g.items.some((i) => i.page === currentPage && i.hash === location.hash));
    // ハッシュ付き項目に一致するときはそれだけを現在地にし、それ以外は ハッシュ無しの項目を現在地にする
    return hasHashItem ? item.hash === location.hash : !item.hash;
  }

  const sidebar = document.createElement('nav');
  sidebar.className = 'shell-sidebar';
  sidebar.setAttribute('aria-label', '管理画面メニュー');

  const brand = document.createElement('a');
  brand.className = 'shell-brand';
  brand.href = 'index.html';
  brand.innerHTML = '<span class="shell-brand-logo"></span><span class="shell-brand-name"></span>';
  sidebar.appendChild(brand);

  NAV.forEach((g) => {
    const group = document.createElement('div');
    group.className = 'shell-group';
    const title = document.createElement('div');
    title.className = 'shell-group-title';
    title.textContent = g.group;
    group.appendChild(title);
    g.items.forEach((item) => {
      const a = document.createElement('a');
      a.className = 'shell-link';
      a.href = item.href;
      a.textContent = item.label;
      a.__item = item;
      group.appendChild(a);
    });
    sidebar.appendChild(group);
  });

  const topbar = document.createElement('div');
  topbar.className = 'shell-topbar';
  topbar.innerHTML = '<span id="shellRecordChip" class="record-chip">記録状態を確認中…</span>';

  function refreshActive() {
    sidebar.querySelectorAll('.shell-link').forEach((a) => {
      const active = isActive(a.__item);
      a.classList.toggle('active', active);
      if (active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }
  refreshActive();
  window.addEventListener('hashchange', refreshActive);

  document.body.insertBefore(topbar, document.body.firstChild);
  document.body.insertBefore(sidebar, document.body.firstChild);

  window.AdminShell = {
    // events: GET /events の配列。live の試合数を上部バーのチップに表示する。
    setRecordStatus(events) {
      const chip = document.getElementById('shellRecordChip');
      if (!chip) return;
      const liveCount = (events || []).filter((e) => e.status === 'live').length;
      chip.classList.toggle('live', liveCount > 0);
      chip.textContent = liveCount > 0 ? `● 記録中 ${liveCount}件` : '■ 記録停止中';
    },
  };
})();
