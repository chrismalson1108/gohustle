import { c, I, avatar, stars, statusBar, tabBar, navBar, doc, shadowCard, shadowSm } from './base.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Demo data. Fictional people, plausible gigs, Monroe LA (the launch market).
// ─────────────────────────────────────────────────────────────────────────────
const JOBS = [
  {
    meta: 'Moving', urgent: true, posted: '2h ago',
    title: 'Help me move a 1-bedroom apartment',
    desc: 'Loading a 15ft truck, short drive across town, then unloading. Everything is boxed and ready to go — mostly boxes plus a couch and a bed frame.',
    tags: ['heavy-lifting', 'truck-provided'],
    pay: '$200 flat', loc: 'Monroe, LA · 1.2 mi',
    poster: { name: 'Daniel K.', initial: 'D', verified: true, rating: 4.9 },
  },
  {
    meta: 'Deep Cleaning', urgent: false, posted: '5h ago',
    title: 'Deep clean before my move-out inspection',
    desc: 'Two bed, one bath. Kitchen appliances, baseboards and bathroom need the most attention. All supplies are already here.',
    tags: ['supplies-provided', 'flexible-timing'],
    pay: '$90–$120 est.', loc: 'Monroe, LA · 2.4 mi',
    poster: { name: 'Priya S.', initial: 'P', verified: true, rating: 5.0 },
  },
  {
    meta: 'Furniture Assembly', urgent: false, posted: '1d ago',
    title: 'Assemble two flat-pack wardrobes',
    desc: 'Boxes are already in the room. I have a drill and a basic tool kit you can use. Should be a two to three hour job.',
    tags: ['tools-provided'],
    pay: '$90 flat', loc: 'West Monroe, LA · 3.8 mi',
    poster: { name: 'Marcus T.', initial: 'M', verified: false, rating: 4.8 },
  },
];

const jobCard = (j, { attached = false, pill = null } = {}) => `
<div class="jcard${attached ? ' jcard-attached' : ''}">
  <div class="jactions">
    <div class="jact">${I('bookmark-outline', 16, c.textMuted)}</div>
    <div class="jact">${I('ellipsis-horizontal', 16, c.textMuted)}</div>
  </div>
  <div class="jbody">
    ${pill ? `<div class="jpill" style="background:${pill.bg};color:${pill.fg}">
        ${I(pill.ion, 13, pill.fg, 'margin-right:5px')}<span>${pill.label}</span></div>` : ''}
    <div class="jhead">
      <div class="jhead-l">
        ${j.urgent ? `<div class="urgent">${I('flash', 10, c.urgent, 'margin-right:3px')}Urgent</div>` : ''}
        <span class="jmeta">${j.meta}</span>
      </div>
      <span class="jtime">${j.posted}</span>
    </div>
    <div class="jtitle">${j.title}</div>
    <div class="jdesc">${j.desc}</div>
    <div class="jtags">${j.tags.map(t => `<span class="jtag">#${t}</span>`).join('')}</div>
    <div class="jfoot">
      <span class="jpay">${j.pay}</span>
      <span class="jloc">${I('location-outline', 12, c.textMuted, 'margin-right:3px')}${j.loc}</span>
    </div>
    <div class="jposter">
      ${avatar(j.poster.initial, 20, 9, c.primary, 'margin-right:6px')}
      <span class="jpname">${j.poster.name}</span>
      ${j.poster.verified ? I('checkmark-circle', 13, c.success, 'margin-left:2px') : ''}
      <span style="flex:1"></span>
      ${stars(j.poster.rating, 12)}
    </div>
  </div>
</div>`;

const JCARD_CSS = `
.jcard{background:${c.surface};border-radius:20px;margin:0 16px 12px;overflow:hidden;box-shadow:${shadowCard};position:relative}
.jcard-attached{border-bottom-left-radius:0;border-bottom-right-radius:0;margin-bottom:0}
.jactions{position:absolute;top:12px;right:12px;z-index:2;display:flex;align-items:center;gap:4px}
.jact{background:rgba(255,255,255,0.92);border-radius:16px;padding:6px;line-height:0}
.jbody{padding:16px}
.jpill{border-radius:10px;padding:5px 10px;margin:0 62px 10px 0;display:flex;align-items:center;justify-content:center;
  font-size:12px;font-weight:700}
.jhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding-right:60px}
.jhead-l{display:flex;align-items:center;flex:1;margin-right:8px;min-width:0}
.urgent{background:${c.urgentLight};color:${c.urgent};border-radius:999px;padding:3px 8px;margin-right:8px;
  font-size:11px;font-weight:700;display:flex;align-items:center;flex-shrink:0}
.jmeta{font-size:12px;font-weight:500;color:${c.textMuted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jtime{font-size:12px;color:${c.textMuted};flex-shrink:0}
.jtitle{font-size:17px;font-weight:700;color:${c.textPrimary};margin-bottom:4px;line-height:22px;letter-spacing:-0.2px}
.jdesc{font-size:13.5px;color:${c.textSecondary};line-height:19px;margin-bottom:12px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.jtags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.jtag{background:${c.background};border-radius:999px;padding:4px 9px;font-size:11px;font-weight:500;color:${c.textSecondary}}
.jfoot{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.jpay{font-size:15px;font-weight:700;color:${c.textPrimary}}
.jloc{display:flex;align-items:center;font-size:12px;color:${c.textMuted};margin-left:10px;min-width:0}
.jposter{display:flex;align-items:center;padding-top:10px;border-top:1px solid ${c.divider}}
.jpname{font-size:12px;font-weight:600;color:${c.textSecondary};margin-right:4px}
`;

// ── 1. Browse (HomeScreen) ───────────────────────────────────────────────────
export function browse() {
  const chips = [
    { label: 'For You', ion: 'sparkles' },
    { label: 'All', ion: 'grid', active: true },
    { label: 'Moving', ion: 'cube' },
    { label: 'House Cleaning', ion: 'sparkles' },
    { label: 'Furniture Assembly', ion: 'build' },
    { label: 'Math Tutoring', ion: 'calculator' },
  ];
  const inner = `
${statusBar()}
<div class="body">
  <div class="hs-header">
    <div class="hs-top">
      <div class="hs-greet">
        <div class="hs-hey">Hey Maya</div>
        <div class="hs-sub">Ready to hustle?</div>
      </div>
      <div class="hs-streak">${I('flame', 14, c.primary)}<span class="hs-streaknum">3</span><span class="hs-streaklabel">week streak</span></div>
    </div>
    <div class="hs-searchrow">
      <div class="hs-searchbox">${I('search', 16, c.textMuted, 'margin-right:8px')}<span class="hs-ph">Search gigs...</span></div>
      <div class="hs-filter">${I('options', 20, '#fff')}</div>
    </div>
  </div>
  <div class="hs-chips">
    ${chips.map(ch => `<div class="hs-chip${ch.active ? ' on' : ''}">
      ${I(ch.ion, 14, ch.active ? '#fff' : c.textSecondary, 'margin-right:6px')}
      <span>${ch.label}</span></div>`).join('')}
    <div class="hs-chip"><span style="color:${c.textPrimary}">More</span>${I('chevron-down', 14, c.textMuted, 'margin-left:6px')}</div>
  </div>
  <div class="hs-results">
    <span class="hs-count">14 gigs available</span>
    <div class="hs-actions">
      <span class="hs-toggle">${I('bar-chart-outline', 16, c.textPrimary)}<span>Insights</span></span>
      <span class="hs-toggle">${I('map-outline', 16, c.textPrimary)}<span>Map</span></span>
    </div>
  </div>
  <div class="scroll">${JOBS.map(j => jobCard(j)).join('')}</div>
  ${tabBar('HomeTab')}
</div>`;
  return doc(inner, JCARD_CSS + `
.hs-header{padding:14px 20px 4px;background:${c.background}}
.hs-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.hs-greet{flex:1;min-width:0;margin-right:12px}
.hs-hey{font-size:26px;font-weight:700;letter-spacing:-0.5px;margin-bottom:2px;line-height:31px}
.hs-sub{font-size:14px;color:${c.textSecondary}}
.hs-streak{display:flex;align-items:center;gap:5px;background:${c.surface};border-radius:999px;padding:7px 12px;flex-shrink:0}
.hs-streaknum{font-size:14px;font-weight:700}
.hs-streaklabel{font-size:12px;color:${c.textSecondary};font-weight:500}
.hs-searchrow{display:flex;align-items:center}
.hs-searchbox{flex:1;display:flex;align-items:center;background:${c.surface};border-radius:14px;padding:0 14px;height:48px}
.hs-ph{font-size:15px;color:${c.textMuted}}
.hs-filter{width:48px;height:48px;border-radius:14px;background:${c.textPrimary};display:flex;align-items:center;justify-content:center;margin-left:10px}
.hs-chips{display:flex;align-items:center;padding:12px 16px 8px;gap:8px;overflow:hidden;flex-shrink:0}
.hs-chip{display:flex;align-items:center;padding:9px 14px;border-radius:999px;background:${c.surface};
  font-size:13px;font-weight:600;color:${c.textPrimary};white-space:nowrap;flex-shrink:0}
.hs-chip.on{background:${c.textPrimary};color:#fff}
.hs-results{display:flex;justify-content:space-between;align-items:center;padding:0 16px;margin:4px 0 8px}
.hs-count{font-size:13px;font-weight:600;color:${c.textMuted}}
.hs-actions{display:flex;align-items:center;gap:10px}
.hs-toggle{display:flex;align-items:center;gap:4px;font-size:13px;font-weight:600;color:${c.textPrimary}}
`);
}

// ── 2. Job detail ────────────────────────────────────────────────────────────
export function jobDetail() {
  const inner = `
${statusBar()}
${navBar()}
<div class="body" style="background:${c.background}">
  <div class="scroll jd">
    <div class="jd-catrow"><span class="jd-cat">Deep Cleaning</span>
      <span class="jd-save">${I('bookmark-outline', 18, c.textMuted)}</span></div>
    <div class="jd-title">Deep clean before my move-out inspection</div>
    <div class="jd-pills">
      <span class="jd-pay">${I('cash', 14, c.washDeep, 'margin-right:5px')}$120 flat rate</span>
      <span class="jd-loc">${I('location', 13, c.textSecondary, 'margin-right:4px')}Monroe, LA</span>
    </div>
    <div class="jd-hint">${I('lock-closed-outline', 13, c.textMuted, 'margin-right:6px;margin-top:2px')}
      <span>The full address is shown here after the poster accepts your booking.</span></div>

    <div class="jd-sec"><div class="jd-sectitle">About this gig</div>
      <div class="jd-desc">Two bed, one bath. Appliances, baseboards and the bathroom need the most attention.</div></div>

    <div class="jd-sec"><div class="jd-sectitle">About the poster</div>
      <div class="jd-trust">
        ${avatar('P', 52, 20, c.primary, 'margin-right:12px')}
        <div style="flex:1;min-width:0">
          <div class="jd-namerow"><span class="jd-name">Priya S.</span>
            <span class="jd-verified">${I('checkmark-circle', 11, c.success, 'margin-right:3px')}Verified</span></div>
          ${stars(5.0)}
          <div class="jd-reviews">8 reviews</div>
        </div>
      </div></div>

    <div class="jd-sec"><div class="jd-sectitle">Available times</div>
      <div class="jd-slots">
        <span class="jd-slot on">Sat, Sep 12 · 9:00 AM</span>
        <span class="jd-slot">Sat, Sep 12 · 1:00 PM</span>
        <span class="jd-slot taken">${I('lock-closed', 13, c.textSecondary, 'margin-right:5px')}Sun</span>
      </div></div>

    <div class="jd-sec"><div class="jd-sectitle">Payment</div>
      <div class="jd-fee">
        <div class="jd-feerow"><span class="jd-feelabel">Gig pay</span><span class="jd-feeval">$120.00</span></div>
        <div class="jd-feerow"><span class="jd-feelabel">GoHustlr service fee (7%)</span><span class="jd-feeval">&minus;$8.40</span></div>
        <div class="jd-feediv"></div>
        <div class="jd-feerow"><span class="jd-feetotal">You receive</span><span class="jd-feetotalval">$111.60</span></div>
        <div class="jd-feenote">Paid securely in-app and released to you after the poster verifies your work.
          Tips (if any) are yours in full.</div>
      </div></div>
  </div>
  <div class="jd-footer"><div class="jd-book">Book this gig</div></div>
</div>`;
  return doc(inner, `
.jd{padding:8px 20px 0;overflow:hidden}
.jd-catrow{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.jd-cat{font-size:13px;font-weight:500;color:${c.textMuted}}
.jd-save{border-radius:999px;padding:8px;border:1px solid ${c.border};background:${c.surface};line-height:0}
.jd-title{font-size:24px;font-weight:700;line-height:31px;letter-spacing:-0.4px;margin-bottom:14px}
.jd-pills{display:flex;flex-wrap:wrap;margin-bottom:8px}
.jd-pay{display:flex;align-items:center;background:${c.wash};color:${c.washDeep};border-radius:999px;
  padding:8px 12px;margin:0 8px 8px 0;font-size:13px;font-weight:600}
.jd-loc{display:flex;align-items:center;background:${c.surface};border:1px solid ${c.border};border-radius:999px;
  padding:8px 12px;margin:0 8px 8px 0;font-size:13px;font-weight:500;color:${c.textSecondary}}
.jd-hint{display:flex;align-items:flex-start;margin:4px 0 12px;font-size:12px;color:${c.textMuted};line-height:17px}
.jd-sec{margin-bottom:16px}
.jd-sectitle{font-size:13px;font-weight:600;color:${c.textMuted};margin-bottom:10px}
.jd-desc{font-size:15px;color:${c.textSecondary};line-height:23px}
.jd-trust{display:flex;align-items:center;background:${c.surface};border-radius:20px;padding:16px;box-shadow:${shadowCard}}
.jd-namerow{display:flex;align-items:center;margin-bottom:4px}
.jd-name{font-size:16px;font-weight:700;margin-right:8px;letter-spacing:-0.2px}
.jd-verified{display:flex;align-items:center;background:${c.successLight};color:${c.success};border-radius:10px;
  padding:3px 8px;font-size:11px;font-weight:600}
.jd-reviews{font-size:12px;color:${c.textMuted};margin-top:4px}
.jd-slots{display:flex;gap:8px;overflow:hidden}
.jd-slot{border-radius:999px;padding:10px 16px;border:1px solid ${c.border};background:${c.surface};
  font-size:13px;font-weight:500;color:${c.textSecondary};white-space:nowrap;display:flex;align-items:center;flex-shrink:0}
.jd-slot.on{background:${c.primary};border-color:${c.primary};color:#fff;font-weight:600}
.jd-slot.taken{background:${c.divider};border-color:${c.divider};color:${c.textSecondary}}
.jd-fee{background:${c.surface};border-radius:20px;padding:16px;box-shadow:${shadowCard}}
.jd-feerow{display:flex;justify-content:space-between;align-items:center;padding:6px 0}
.jd-feelabel{font-size:14px;color:${c.textSecondary}}
.jd-feeval{font-size:14px;font-weight:500}
.jd-feediv{height:1px;background:${c.divider};margin:8px 0}
.jd-feetotal{font-size:15px;font-weight:600}
.jd-feetotalval{font-size:16px;font-weight:700}
.jd-feenote{font-size:12px;color:${c.textMuted};line-height:17px;margin-top:12px}
.jd-footer{position:absolute;left:0;right:0;bottom:0;background:${c.surface};padding:20px 20px 40px;
  border-top:1px solid ${c.divider}}
.jd-book{background:${c.primary};border-radius:14px;padding:16px 20px;text-align:center;color:#fff;font-size:16px;font-weight:700}
`);
}

// ── 3. My Jobs (EarnScreen) ──────────────────────────────────────────────────
export function myJobs() {
  const active = { ...JOBS[0] };
  const inner = `
${statusBar()}
<div class="body">
  <div class="es-header">
    <div class="es-titlerow">${I('briefcase-outline', 22, c.textPrimary, 'margin-right:8px')}<span class="es-title">My Jobs</span></div>
    <div class="es-chips">
      <span class="es-week"><b>$340</b><span>this week &rsaquo;</span></span>
      <span class="es-pill">${I('flame', 15, c.primary, 'margin-right:5px')}3-week streak</span>
      <span class="es-pill">${I('star', 13, c.primary, 'margin-right:5px')}Lv 4</span>
    </div>
  </div>
  <div class="es-seg">
    <div class="es-segbtn on">Active (2)</div>
    <div class="es-segbtn">Awaiting (2)</div>
    <div class="es-segbtn">Completed (8)</div>
  </div>
  <div class="scroll" style="padding-top:16px">
    ${jobCard(active, { attached: true, pill: { label: 'Confirmed — In Progress', ion: 'checkmark-circle', bg: c.successLight, fg: c.success } })}
    <div class="es-meta">
      <div class="es-mrow">${I('calendar-outline', 13, c.textMuted, 'margin-right:6px;margin-top:2px')}
        <span>Sat, Sep 12 · 9:00 AM</span></div>
      <div class="es-progress">${I('ellipse', 9, c.success, 'margin-right:5px')}In progress</div>
      <div class="es-cta">${I('checkmark-done', 16, '#fff', 'margin-right:6px')}I finished this job</div>
      <div class="es-help">Next: mark the job done when you've finished.</div>
      <div class="es-secondary">
        <span class="es-msg">${I('chatbubble-ellipses-outline', 15, c.textSecondary, 'margin-right:6px')}Message</span>
        <span class="es-locked">Can't cancel — you've started.</span>
      </div>
    </div>
    ${jobCard(JOBS[2], { attached: true, pill: { label: 'Confirmed — In Progress', ion: 'checkmark-circle', bg: c.successLight, fg: c.success } })}
    <div class="es-meta">
      <div class="es-mrow">${I('calendar-outline', 13, c.textMuted, 'margin-right:6px;margin-top:2px')}
        <span>Sun, Sep 13 · 2:00 PM</span></div>
      <div class="es-cta green">${I('play', 16, '#fff', 'margin-right:6px')}Start job · I'm on site</div>
      <div class="es-help">Next: tap when you arrive on site.</div>
    </div>
  </div>
  ${tabBar('EarnTab')}
</div>`;
  return doc(inner, JCARD_CSS + `
.es-header{padding:14px 20px 12px;background:${c.background}}
.es-titlerow{display:flex;align-items:center;margin-bottom:12px}
.es-title{font-size:25px;font-weight:700;letter-spacing:-0.4px}
.es-chips{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.es-week{display:flex;align-items:baseline;background:${c.surface};border-radius:999px;padding:8px 14px}
.es-week b{font-size:16px;font-weight:700}
.es-week span{font-size:12px;font-weight:500;color:${c.textSecondary};margin-left:6px}
.es-pill{display:flex;align-items:center;background:${c.surface};border-radius:999px;padding:8px 12px;
  font-size:13px;font-weight:600}
.es-seg{display:flex;margin:16px 16px 0;background:${c.surface};border-radius:999px;padding:4px;border:1px solid ${c.border}}
.es-segbtn{flex:1;padding:12px 0;text-align:center;border-radius:999px;font-size:13px;font-weight:600;color:${c.textSecondary}}
.es-segbtn.on{background:${c.primary};color:#fff}
.es-meta{background:${c.surface};border-radius:20px;padding:16px;margin:0 16px 16px;border-top:1px solid ${c.divider};
  border-top-left-radius:0;border-top-right-radius:0;box-shadow:${shadowCard}}
.es-mrow{display:flex;align-items:flex-start;font-size:13px;color:${c.textSecondary};line-height:18px}
.es-progress{display:inline-flex;align-items:center;background:${c.successLight};color:${c.success};border-radius:10px;
  padding:6px 10px;margin-top:8px;font-size:12px;font-weight:600}
.es-cta{display:flex;align-items:center;justify-content:center;background:${c.primary};border-radius:14px;
  padding:14px 16px;margin-top:12px;color:#fff;font-size:15px;font-weight:700}
.es-cta.green{background:${c.success}}
.es-help{font-size:12px;color:${c.textMuted};margin-top:8px;line-height:16px}
.es-secondary{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px}
.es-msg{display:flex;align-items:center;border:1px solid ${c.border};border-radius:14px;padding:10px 14px;
  font-size:13px;font-weight:600;color:${c.textSecondary}}
.es-locked{font-size:12px;color:${c.textMuted};text-align:right}
`);
}

// ── 4. Chat ──────────────────────────────────────────────────────────────────
export function chat() {
  const msgs = [
    { mine: true, text: "Hi Daniel — just applied for the move on Saturday. I've done about a dozen of these.", t: '8:44 AM' },
    { mine: false, text: "Accepted! Your reviews looked great.", t: '8:51 AM' },
    { mine: true, text: "Thank you! Anything I should know before I show up?", t: '8:58 AM' },
    { mine: false, text: "Hi Maya — thanks for booking! Everything is boxed up and ready by the door.", t: '9:02 AM' },
    { mine: true, text: "Perfect. I'll be there at 9 on Saturday. Is there an elevator or is it stairs?", t: '9:05 AM' },
    { mine: false, text: "Ground floor both ends, no stairs at all. Parking is right outside.", t: '9:06 AM' },
    { mine: true, text: "Even better. I'll bring straps and a dolly.", t: '9:08 AM' },
    { mine: false, text: "You're a lifesaver. See you Saturday!", t: '9:09 AM' },
  ];
  const inner = `
${statusBar()}
<div class="navbar">
  <div class="nav-back">${I('chevron-back', 26, c.textPrimary)}</div>
  <div class="nav-title" style="display:flex;align-items:center;justify-content:center;gap:8px">
    ${avatar('D', 26, 12)}<span style="font-size:16px;font-weight:700;letter-spacing:-0.2px">Daniel K.</span></div>
</div>
<div class="body" style="background:${c.surface}">
  <div class="ch-context">
    <div class="ch-job">
      <div class="ch-photo">${I('briefcase-outline', 18, c.textMuted)}</div>
      <div style="flex:1;margin:0 8px 0 10px;min-width:0">
        <div class="ch-jtitle">Help me move a 1-bedroom apartment</div>
        <div class="ch-jmeta">$200 · Monroe, LA</div>
      </div>
      ${I('chevron-forward', 16, c.textMuted)}
    </div>
  </div>
  <div class="ch-list">
    ${msgs.map(m => `<div class="ch-row${m.mine ? ' mine' : ''}">
      <div class="ch-bubble${m.mine ? ' mine' : ''}">
        <div class="ch-text">${m.text}</div>
        <div class="ch-time">${m.t}</div>
      </div></div>`).join('')}
  </div>
  <div class="ch-input">
    <div class="ch-attach">${I('image-outline', 22, c.textMuted)}</div>
    <div class="ch-field">Message…</div>
    <div class="ch-send">${I('send', 18, '#fff')}</div>
  </div>
</div>`;
  return doc(inner, `
.ch-context{padding:10px 16px 12px;border-bottom:0.5px solid ${c.divider}}
.ch-job{display:flex;align-items:center;background:${c.background};border-radius:14px;padding:8px}
.ch-photo{width:40px;height:40px;border-radius:10px;background:${c.divider};display:flex;align-items:center;justify-content:center;flex-shrink:0}
.ch-jtitle{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ch-jmeta{font-size:12px;color:${c.textMuted};margin-top:2px}
.ch-list{flex:1;min-height:0;padding:16px 20px;display:flex;flex-direction:column;justify-content:flex-end;gap:12px;overflow:hidden}
.ch-row{display:flex;align-items:flex-end}
.ch-row.mine{justify-content:flex-end}
.ch-bubble{background:${c.background};border-radius:20px;border-bottom-left-radius:10px;padding:10px 14px;max-width:75%}
.ch-bubble.mine{background:${c.primary};border-bottom-left-radius:20px;border-bottom-right-radius:10px}
.ch-text{font-size:14px;line-height:20px;color:${c.textPrimary}}
.ch-bubble.mine .ch-text{color:#fff}
.ch-time{font-size:11px;color:${c.textMuted};margin-top:4px;text-align:right;line-height:15px}
.ch-bubble.mine .ch-time{color:rgba(255,255,255,0.72)}
.ch-input{display:flex;align-items:flex-end;padding:12px 20px 28px;border-top:1px solid ${c.divider}}
.ch-attach{width:42px;height:42px;border-radius:999px;display:flex;align-items:center;justify-content:center;margin-right:6px}
.ch-field{flex:1;background:${c.surface};border:1px solid ${c.border};border-radius:999px;padding:11px 16px;
  font-size:14px;color:${c.textMuted};margin-right:8px}
.ch-send{width:42px;height:42px;border-radius:999px;background:${c.primary};display:flex;align-items:center;justify-content:center;flex-shrink:0}
`);
}

// ── 5. Transactions (PaymentsScreen) ────────────────────────────────────────
export function transactions() {
  const TONE = {
    good: { bg: c.successLight, fg: c.success },
    hold: { bg: c.warningLight, fg: c.warningDeep },
    muted: { bg: c.border, fg: c.textSecondary },
  };
  const rows = [
    { title: 'Help me move a 1-bedroom apartment', date: 'Sep 6', st: 'In escrow', tone: 'hold', amt: '$186.00' },
    { title: 'Deep clean before move-out inspection', date: 'Sep 2', st: 'Released', tone: 'good', amt: '$111.60' },
    { title: 'Assemble two flat-pack wardrobes', date: 'Sep 1', st: 'Released', tone: 'good', amt: '$83.70' },
  ];
  const trend = [
    { l: 'Apr', h: 34 }, { l: 'May', h: 52 }, { l: 'Jun', h: 45 },
    { l: 'Jul', h: 71 }, { l: 'Aug', h: 88 }, { l: 'Sep', h: 46 },
  ];
  const inner = `
${statusBar()}
${navBar('Transactions')}
<div class="body">
  <div class="px-header">
    <div class="px-seg"><div class="px-segbtn on">Earnings</div><div class="px-segbtn">Spending</div></div>
    <div class="px-chips">
      <span class="px-chip">30 days</span><span class="px-chip on">90 days</span>
      <span class="px-chip">This year</span><span class="px-chip">Last year</span>
      <span class="px-chip">${I('search', 14, c.textSecondary)}</span>
    </div>
    <div class="px-chips">
      <span class="px-chip on">All</span><span class="px-chip">In escrow</span>
      <span class="px-chip">Completed</span><span class="px-chip">Refunded</span>
    </div>
  </div>
  <div class="scroll" style="padding:14px 16px 0">
    <div class="px-summary">
      <div class="px-cell">
        <div class="px-label">Earned · 90 days</div>
        <div class="px-value">$1,284.60</div>
        <div class="px-hint">9 completed · $142.73 avg</div>
      </div>
      <div class="px-div"></div>
      <div class="px-cell">
        <div class="px-label">In escrow</div>
        <div class="px-value" style="color:${c.warningDeep}">$186.00</div>
        <div class="px-hint">released on verify</div>
      </div>
    </div>
    <div class="px-trend">${trend.map(t => `<div class="px-tcol">
      <div class="px-ttrack"><div class="px-tbar" style="height:${t.h}%"></div></div>
      <div class="px-tlabel">${t.l}</div></div>`).join('')}</div>
    <div class="px-stats">
      <div class="px-srow"><span class="px-slabel">Gig totals</span><span class="px-sval">$1,381.30</span></div>
      <div class="px-srow"><span class="px-slabel">Platform fees</span><span class="px-sval" style="color:${c.textSecondary}">&minus; $96.70</span></div>
      <div class="px-srow"><span class="px-slabel">Tips</span><span class="px-sval" style="color:${c.success}">+ $65.00</span></div>
      <div class="px-srow"><span class="px-slabel">Transactions</span><span class="px-sval">11</span></div>
    </div>
    <div class="px-actions">
      <span class="px-btn">${I('business-outline', 15, c.primary)}<span>Bank deposits</span></span>
      <span class="px-btn">${I('download-outline', 15, c.primary)}<span>Export CSV</span></span>
    </div>
    <div class="px-month">September 2026</div>
    ${rows.map(r => `<div class="px-row">
      <div style="flex:1;min-width:0;margin-right:10px">
        <div class="px-rtitle">${r.title}</div>
        <div class="px-rmeta"><span class="px-rdate">${r.date}</span>
          <span class="px-tag" style="background:${TONE[r.tone].bg};color:${TONE[r.tone].fg}">${r.st}</span></div>
      </div>
      <div class="px-amt">${r.amt}</div>
    </div>`).join('')}
  </div>
</div>`;
  return doc(inner, `
.px-header{padding:14px 16px 0;background:${c.background}}
.px-seg{display:flex;background:${c.border};border-radius:999px;padding:3px}
.px-segbtn{flex:1;padding:8px 0;text-align:center;border-radius:999px;font-size:13px;font-weight:700;color:${c.textSecondary}}
.px-segbtn.on{background:${c.surface};color:${c.textPrimary};box-shadow:${shadowSm}}
.px-chips{display:flex;gap:6px;padding-top:10px;overflow:hidden}
.px-chip{padding:7px 12px;border-radius:999px;border:1px solid ${c.border};background:${c.surface};
  font-size:12.5px;font-weight:700;color:${c.textSecondary};white-space:nowrap;display:flex;align-items:center}
.px-chip.on{background:${c.primary};border-color:${c.primary};color:#fff}
.px-summary{display:flex;background:${c.surface};border-radius:20px;padding:16px;box-shadow:${shadowCard}}
.px-cell{flex:1}
.px-div{width:1px;background:${c.border};margin:0 12px}
.px-label{font-size:12px;color:${c.textSecondary};font-weight:600}
.px-value{font-size:24px;font-weight:800;margin-top:4px}
.px-hint{font-size:11px;color:${c.textSecondary};margin-top:2px}
.px-trend{display:flex;gap:8px;height:92px;margin-top:12px;padding:0 4px}
.px-tcol{flex:1;display:flex;flex-direction:column;align-items:center}
.px-ttrack{flex:1;width:100%;display:flex;align-items:flex-end;background:${c.border};border-radius:10px;overflow:hidden}
.px-tbar{width:100%;background:${c.primary};border-radius:10px}
.px-tlabel{font-size:10px;color:${c.textSecondary};margin-top:4px;font-weight:600}
.px-stats{background:${c.surface};border-radius:20px;padding:14px;margin-top:12px;box-shadow:${shadowSm}}
.px-srow{display:flex;justify-content:space-between;padding:6px 0}
.px-slabel{font-size:13.5px}
.px-sval{font-size:13.5px;font-weight:700}
.px-actions{display:flex;gap:8px;margin-top:12px}
.px-btn{display:flex;align-items:center;gap:6px;padding:8px 12px;border-radius:999px;border:1px solid ${c.border};
  background:${c.surface};font-size:13px;font-weight:700;color:${c.primary}}
.px-month{font-size:12px;font-weight:800;color:${c.textSecondary};text-transform:uppercase;letter-spacing:0.5px;padding:20px 0 8px}
.px-row{display:flex;align-items:center;background:${c.surface};margin-bottom:8px;padding:14px;border-radius:20px;box-shadow:${shadowSm}}
.px-rtitle{font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.px-rmeta{display:flex;align-items:center;gap:8px;margin-top:5px}
.px-rdate{font-size:12px;color:${c.textSecondary}}
.px-tag{padding:3px 8px;border-radius:999px;font-size:11px;font-weight:800}
.px-amt{font-size:16px;font-weight:800;flex-shrink:0}
`);
}

// ── 6. Profile / Progress ────────────────────────────────────────────────────
export function profile() {
  const badges = [
    { ion: 'rocket', label: 'First Gig', on: true },
    { ion: 'flame', label: 'On a Roll', on: true },
    { ion: 'star', label: 'Five Star', on: true },
    { ion: 'trophy', label: 'Top Earner', on: false },
  ];
  const inner = `
${statusBar()}
<div class="body">
  <div class="pf-header">
    <div class="pf-top">
      <div class="pf-youwrap"><span class="pf-you">You</span></div>
      <div style="width:38px"></div>
      <div class="pf-actions">
        <span class="pf-icon">${I('notifications-outline', 22, c.textPrimary)}<span class="pf-badge">2</span></span>
        <span class="pf-icon">${I('settings-outline', 22, c.textPrimary)}</span>
      </div>
    </div>
  </div>
  <div class="pf-seg">
    <div class="pf-segbtn"><span class="on">Progress</span><div class="pf-bar on"></div></div>
    <div class="pf-segbtn"><span>Profile</span><div class="pf-bar"></div></div>
  </div>
  <div class="scroll">
    <div class="pf-stats">
      <div class="pf-stat"><div class="pf-sval">12</div><div class="pf-slabel">Jobs done</div></div>
      <div class="pf-sdiv"></div>
      <div class="pf-stat"><div class="pf-sval">$2,140</div><div class="pf-slabel">Total earned</div></div>
      <div class="pf-sdiv"></div>
      <div class="pf-stat"><div class="pf-sval">4.9 &#9733;</div><div class="pf-slabel">Avg rating</div></div>
    </div>

    <div class="mg-card">
      <div class="mg-head">
        <div class="mg-circle">${I('flag', 18, c.textPrimary)}</div>
        <div style="flex:1;margin-right:8px">
          <div class="mg-title">Money goal</div>
          <div class="mg-sub">22 days left this month</div>
        </div>
        <span class="mg-pace">Ahead of pace</span>
      </div>
      <div class="mg-goal"><span class="mg-earned">$640</span><span class="mg-of">of $1,200</span>
        ${I('pencil', 13, c.textMuted)}</div>
      <div class="mg-bar"><div class="mg-fill" style="width:53%"></div></div>
      <div class="mg-stats">
        <div class="mg-stat"><div class="mg-sv">$560</div><div class="mg-sl">Left to go</div></div>
        <div class="mg-stat"><div class="mg-sv">4</div><div class="mg-sl">Gigs to go</div></div>
        <div class="mg-stat"><div class="mg-sv">$180</div><div class="mg-sl">Per week</div></div>
      </div>
      <div class="mg-picks">
        <div class="mg-ptitle">Best gigs to hit your goal</div>
        <div class="mg-prow"><span class="mg-pt">Help me move a 1-bedroom apartment</span><span class="mg-pp">$200</span></div>
      </div>
    </div>

    <div class="et-card">
      <div class="et-title">Earnings</div>
      <div class="et-row">
        <div class="et-tile"><div class="et-val">$0</div><div class="et-label">Today</div></div>
        <div class="et-tile"><div class="et-val">$340</div><div class="et-label">This week</div></div>
        <div class="et-tile"><div class="et-val">$2,140</div><div class="et-label">All time</div></div>
        <div class="et-tile"><div class="et-val">$178</div><div class="et-label">Avg/job</div></div>
      </div>
    </div>

    <div class="pf-sec">
      <div class="pf-sectitle">Badges</div>
      <div class="pf-badges">${badges.map(b => `<div class="pf-btile${b.on ? '' : ' off'}">
        ${I(b.ion, 22, b.on ? c.primary : c.textMuted)}<div class="pf-blabel">${b.label}</div></div>`).join('')}</div>
    </div>
  </div>
  ${tabBar('ProfileTab')}
</div>`;
  return doc(inner, `
.pf-header{padding:14px 20px 0;background:${c.background}}
.pf-top{display:flex;align-items:center;justify-content:space-between;min-height:40px;position:relative}
.pf-youwrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.pf-you{font-size:20px;font-weight:800;letter-spacing:-0.3px}
.pf-actions{display:flex;align-items:center;gap:4px}
.pf-icon{padding:8px;border-radius:999px;position:relative;line-height:0}
.pf-badge{position:absolute;top:2px;right:2px;background:${c.urgent};color:#fff;font-size:10px;font-weight:700;
  border-radius:8px;min-width:16px;height:16px;display:flex;align-items:center;justify-content:center;padding:0 4px;line-height:1}
.pf-seg{display:flex;background:${c.background};border-bottom:0.5px solid ${c.border};margin-top:8px}
.pf-segbtn{flex:1;display:flex;flex-direction:column;align-items:center;padding-top:12px}
.pf-segbtn span{font-size:15px;font-weight:600;color:${c.textMuted};margin-bottom:10px}
.pf-segbtn span.on{color:${c.textPrimary};font-weight:700}
.pf-bar{height:2px;width:60%;background:transparent;border-radius:1px}
.pf-bar.on{background:${c.primary}}
.pf-stats{background:${c.surface};margin:12px 20px 0;border-radius:20px;display:flex;align-items:center;
  padding:16px 8px;box-shadow:${shadowCard}}
.pf-stat{flex:1;text-align:center;padding:0 4px}
.pf-sval{font-size:20px;font-weight:700;margin-bottom:4px}
.pf-slabel{font-size:12px;color:${c.textMuted};font-weight:500}
.pf-sdiv{width:1px;height:32px;background:${c.border}}
.mg-card{background:${c.surface};border-radius:20px;padding:16px;margin:16px 16px 0;box-shadow:${shadowCard}}
.mg-head{display:flex;align-items:center;gap:12px}
.mg-circle{width:36px;height:36px;border-radius:999px;background:${c.background};display:flex;align-items:center;justify-content:center;flex-shrink:0}
.mg-title{font-size:15px;font-weight:700;letter-spacing:-0.2px}
.mg-sub{font-size:12px;color:${c.textMuted};margin-top:2px}
.mg-pace{background:${c.successLight};color:${c.success};border-radius:999px;padding:4px 10px;font-size:11px;font-weight:600;flex-shrink:0}
.mg-goal{display:flex;align-items:baseline;gap:6px;margin-top:16px}
.mg-earned{font-size:26px;font-weight:700;letter-spacing:-0.4px}
.mg-of{font-size:13px;font-weight:500;color:${c.textMuted}}
.mg-bar{height:8px;border-radius:999px;background:${c.divider};overflow:hidden;margin-top:12px}
.mg-fill{height:100%;border-radius:999px;background:${c.primary}}
.mg-stats{display:flex;gap:8px;margin-top:16px}
.mg-stat{flex:1;background:${c.background};border-radius:14px;padding:12px 8px;text-align:center}
.mg-sv{font-size:15px;font-weight:700}
.mg-sl{font-size:11px;color:${c.textMuted};margin-top:4px}
.mg-picks{margin-top:16px;border-top:1px solid ${c.divider};padding-top:16px}
.mg-ptitle{font-size:13px;font-weight:600;color:${c.textMuted};margin-bottom:8px}
.mg-prow{display:flex;align-items:center;justify-content:space-between;gap:8px;background:${c.background};
  border-radius:14px;padding:12px;margin-bottom:8px}
.mg-pt{font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mg-pp{font-size:14px;font-weight:700;flex-shrink:0}
.et-card{margin:12px 16px 0;background:${c.surface};border-radius:20px;padding:16px;box-shadow:${shadowCard}}
.et-title{font-size:13px;font-weight:600;color:${c.textMuted};margin-bottom:12px}
.et-row{display:flex;gap:8px}
.et-tile{flex:1;background:${c.background};border-radius:14px;padding:12px 4px;text-align:center}
.et-val{font-size:15px;font-weight:700}
.et-label{font-size:11px;color:${c.textMuted};margin-top:4px}
.pf-sec{padding:0 20px;margin-top:24px}
.pf-sectitle{font-size:13px;font-weight:600;color:${c.textMuted};margin-bottom:8px}
.pf-badges{display:flex;gap:8px}
.pf-btile{flex:1;background:${c.surface};border-radius:14px;padding:14px 6px;text-align:center;box-shadow:${shadowSm}}
.pf-btile.off{opacity:0.45}
.pf-blabel{font-size:11px;font-weight:600;margin-top:6px;color:${c.textSecondary}}
`);
}

// ── 7. Post a gig ────────────────────────────────────────────────────────────
export function postGig() {
  const field = (label, value, { ph = false, tall = false } = {}) => `
    <div class="pg-field"><div class="pg-label">${label}</div>
      <div class="pg-input${tall ? ' tall' : ''}" style="color:${ph ? c.textMuted : c.textPrimary}">${value}</div></div>`;
  const inner = `
${statusBar()}
${navBar()}
<div class="body">
  <div class="pg-header">
    <div class="pg-title">Post a gig</div>
    <div class="pg-sub">Hire a motivated college student</div>
  </div>
  <div class="scroll pg-form">
    ${field('Job title *', 'Help me move a 1-bedroom apartment')}
    <div class="pg-field"><div class="pg-label">Category *</div>
      <div class="pg-cat"><span class="pg-catchip">${I('cube', 13, '#fff', 'margin-right:6px')}Moving
        ${I('close', 13, 'rgba(255,255,255,0.8)', 'margin-left:6px')}</span></div>
      <div class="pg-recents">Recent</div>
      <div class="pg-catgrid">
        <span class="pg-chip">${I('sparkles', 13, c.textSecondary, 'margin-right:6px')}House Cleaning</span>
        <span class="pg-chip">${I('leaf', 13, c.textSecondary, 'margin-right:6px')}Lawn Care</span>
      </div>
    </div>
    <div class="pg-two">
      <div style="flex:1">${field('Pay *', '$200')}</div>
      <div style="flex:1">${field('Pay type', 'Flat rate')}</div>
    </div>
    ${field('Location *', 'Monroe, LA')}
    ${field('Description *', 'Loading a 15ft truck, short drive across town, then unloading. Everything is boxed and ready to go.', { tall: true })}
    <div class="pg-field"><div class="pg-label">Available times</div>
      <div class="pg-slots">
        <span class="pg-slot on">Sat, Sep 12 · 9:00 AM</span>
        <span class="pg-slot on">Sat, Sep 12 · 1:00 PM</span>
        <span class="pg-slot">+ Add</span>
      </div>
    </div>
    <div class="pg-urgent">Mark as urgent (optional)</div>
    <div class="pg-cta">Post gig</div>
  </div>
</div>`;
  return doc(inner, `
.pg-header{padding:14px 20px 12px;background:${c.background}}
.pg-title{font-size:25px;font-weight:700;letter-spacing:-0.4px}
.pg-sub{font-size:14px;color:${c.textSecondary};margin-top:4px}
.pg-form{padding:0 20px;overflow:hidden}
.pg-field{margin-bottom:14px}
.pg-label{font-size:13px;font-weight:600;color:${c.textSecondary};margin-bottom:6px}
.pg-input{background:${c.surface};border:1px solid ${c.border};border-radius:14px;padding:14px;
  font-size:15px;line-height:21px}
.pg-input.tall{min-height:88px}
.pg-cat{background:${c.surface};border:1px solid ${c.border};border-radius:14px;padding:10px 12px}
.pg-catchip{display:inline-flex;align-items:center;background:${c.primary};color:#fff;border-radius:999px;
  padding:6px 12px;font-size:13px;font-weight:600}
.pg-recents{font-size:12px;font-weight:600;color:${c.textMuted};margin:10px 0 6px}
.pg-catgrid{display:flex;gap:8px}
.pg-chip{display:inline-flex;align-items:center;background:${c.surface};border:1px solid ${c.border};
  border-radius:999px;padding:8px 12px;font-size:13px;font-weight:500;color:${c.textPrimary}}
.pg-two{display:flex;gap:12px}
.pg-slots{display:flex;gap:8px;flex-wrap:wrap}
.pg-slot{border-radius:999px;padding:10px 14px;border:1px solid ${c.border};background:${c.surface};
  font-size:13px;font-weight:500;color:${c.textSecondary}}
.pg-slot.on{background:${c.primary};border-color:${c.primary};color:#fff;font-weight:600}
.pg-urgent{border:1px solid ${c.border};border-radius:14px;padding:14px 16px;text-align:center;background:${c.surface};
  font-size:14px;font-weight:600;color:${c.textPrimary};margin-bottom:20px}
.pg-cta{background:${c.primary};border-radius:14px;padding:16px 20px;text-align:center;color:#fff;font-size:16px;font-weight:700}
`);
}

export const SCREENS = {
  '01-browse': { fn: browse, caption: 'Find real work near you' },
  '02-gig-details': { fn: jobDetail, caption: 'See exactly what you take home' },
  '03-my-jobs': { fn: myJobs, caption: 'Every gig, start to finish' },
  '04-messages': { fn: chat, caption: 'Chat in-app. Your number stays private' },
  '05-transactions': { fn: transactions, caption: 'Secure payments, real receipts' },
  '06-progress': { fn: profile, caption: 'Build a reputation that pays' },
  '07-post-a-gig': { fn: postGig, caption: 'Post a gig in under a minute' },
};
