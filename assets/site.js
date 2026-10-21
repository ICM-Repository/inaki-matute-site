(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(hover:hover) and (pointer:fine)').matches;

  // Scroll reveals
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  document.querySelectorAll('.rv').forEach((el) => io.observe(el));

  // Count-up on proof figures
  const ease = (t) => 1 - Math.pow(1 - t, 4);
  const co = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return;
    co.unobserve(e.target);
    const end = +e.target.dataset.count;
    if (reduce) return;
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min((t - t0) / 1600, 1);
      e.target.textContent = Math.round(end * ease(p));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), { threshold: 0.6 });
  document.querySelectorAll('[data-count]').forEach((el) => co.observe(el));

  // Index accordion (one open per list), images load only when opened
  document.querySelectorAll('[data-index]').forEach((list) => {
    list.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.row > button');
      if (!btn) return;
      const row = btn.parentElement;
      const open = row.dataset.open !== 'true';
      list.querySelectorAll('.row').forEach((r) => {
        r.dataset.open = 'false';
        r.querySelector('button').setAttribute('aria-expanded', 'false');
      });
      if (open) {
        row.dataset.open = 'true';
        btn.setAttribute('aria-expanded', 'true');
        const fig = row.querySelector('figure[data-img]');
        if (fig && !fig.firstChild) {
          const img = new Image();
          img.alt = '';
          img.decoding = 'async';
          img.onload = () => fig.appendChild(img);
          img.src = 'images/' + fig.dataset.img + '.jpg';
        }
      }
    });
  });

  // Prefill the enquiry from a row
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-service]');
    if (!a) return;
    const s = document.getElementById('service');
    s.value = [...s.options].some((o) => o.value === a.dataset.service) ? a.dataset.service : s.value;
  });

  if (!fine || reduce) return;

  // Cursor
  const cur = document.querySelector('.cur');
  let x = 0, y = 0, cx = 0, cy = 0;
  addEventListener('pointermove', (e) => { x = e.clientX; y = e.clientY; }, { passive: true });
  (function loop() {
    cx += (x - cx) * 0.2; cy += (y - cy) * 0.2;
    cur.style.transform = `translate(${cx}px,${cy}px)`;
    requestAnimationFrame(loop);
  })();
  document.querySelectorAll('a,button,.row').forEach((el) => {
    el.addEventListener('pointerenter', () => cur.classList.add('big'));
    el.addEventListener('pointerleave', () => cur.classList.remove('big'));
  });

  // Magnetic buttons
  document.querySelectorAll('[data-mag]').forEach((b) => {
    b.addEventListener('pointermove', (e) => {
      const r = b.getBoundingClientRect();
      b.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * 0.25}px,${(e.clientY - r.top - r.height / 2) * 0.35}px)`;
    });
    b.addEventListener('pointerleave', () => { b.style.transform = ''; });
  });
})();
