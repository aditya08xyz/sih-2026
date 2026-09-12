
(function(){
  "use strict";

  /* ---------------- Parameter definitions ---------------- */
  const PARAMS = [
    {key:'ph',        label:'pH',         unit:'',      min:0,    max:14,   step:0.1,  def:5.8,  safeMin:6.5, safeMax:8.5, dec:1},
    {key:'turbidity', label:'Turbidity',  unit:'NTU',   min:0,    max:100,  step:1,    def:45,   safeMax:5,   dec:1},
    {key:'tds',       label:'TDS',        unit:'mg/L',  min:0,    max:3000, step:10,   def:1800, safeMax:500, dec:0},
    {key:'iron',      label:'Iron',       unit:'mg/L',  min:0,    max:10,   step:0.05, def:2.5,  safeMax:0.3, dec:2},
    {key:'arsenic',   label:'Arsenic',    unit:'mg/L',  min:0,    max:0.5,  step:0.005,def:0.08, safeMax:0.01,dec:3},
    {key:'fluoride',  label:'Fluoride',   unit:'mg/L',  min:0,    max:10,   step:0.1,  def:3.2,  safeMax:1.0, dec:2},
  ];

  const REDUCTION = { // multiplier applied at each of the 4 stages
    turbidity:[0.12, 0.35, 0.15, 0.85],
    tds:      [0.97, 0.85, 0.12, 0.98],
    iron:     [0.55, 0.15, 0.35, 0.9],
    arsenic:  [0.9,  0.45, 0.08, 0.9],
    fluoride: [0.95, 0.75, 0.15, 0.9],
  };

  const STAGE_DESCRIPTIONS = {
    raw:      {name:'Raw Water Inlet Tank', text:'Untreated water drawn from the borewell / mining-affected source collects here before treatment begins. Sensors record the baseline quality that triggers alerts if contamination is severe.'},
    sediment: {name:'Stage 01 — Sediment Filter', text:'A layered sand &amp; gravel bed traps suspended solids, silt and coarse particles, cutting turbidity sharply before the water moves on to finer filtration.'},
    carbon:   {name:'Stage 02 — Activated Carbon', text:'Porous activated-carbon granules adsorb dissolved iron, organic compounds and odour-causing impurities, further clarifying the water.'},
    ro:       {name:'Stage 03 — RO / UF Membrane', text:'A high-pressure Reverse Osmosis / Ultrafiltration membrane blocks dissolved salts, arsenic, fluoride and microorganisms at a near-molecular level — the core purification step.'},
    tank:     {name:'Clean Water Storage Tank', text:'Purified, quality-checked water is stored here for community distribution, with sensors continuously confirming it stays within safe limits.'},
  };

  const STAGE_ENGAGE = {sediment:0, carbon:0.25, ro:0.5, tank:0.75};

  /* ---------------- State ---------------- */
  let raw = {};        // slider values
  let before = null;   // snapshot at start
  let current = {};     // live displayed values
  let checkpoints = {}; // per-param [c0..c4]
  let isRunning = false, isPaused = false;
  let startTime = 0, pausedElapsed = 0;
  const DURATION = 12000;
  let zoom = 1;
  let selectedStage = null;
  let rafId = null;
  const particleTimers = [];

  PARAMS.forEach(p => raw[p.key] = p.def);
  current = {...raw};

  /* ---------------- Helpers ---------------- */
  function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
  function lerp(a,b,t){return a+(b-a)*t;}
  function smooth(t){return t*t*(3-2*t);}
  function fmt(p,v){return v.toFixed(p.dec) + (p.unit? ' '+p.unit : '');}
  function isSafe(p,v){
    if(p.key==='ph') return v>=p.safeMin && v<=p.safeMax;
    return v<=p.safeMax;
  }

  function computeCheckpoints(rawVals){
    const cp = {};
    PARAMS.forEach(p=>{
      const arr=[rawVals[p.key]];
      if(p.key==='ph'){
        const target=7.2;
        const pulls=[0.25,0.35,0.6,0.8];
        let v=rawVals.ph;
        pulls.forEach(f=>{ v = v + (target-v)*f; arr.push(v); });
      } else {
        const facs=REDUCTION[p.key];
        let v=rawVals[p.key];
        facs.forEach(f=>{ v=v*f; arr.push(v); });
        // guarantee a safe final outcome for a convincing demo
        arr[4] = Math.min(arr[4], p.safeMax*0.65);
        arr[4] = Math.max(arr[4], 0);
      }
      cp[p.key]=arr;
    });
    return cp;
  }

  function valueAt(p, progress){
    const arr = checkpoints[p.key];
    const seg = clamp(Math.floor(progress*4), 0, 3);
    const local = clamp(progress*4 - seg, 0, 1);
    return lerp(arr[seg], arr[seg+1], smooth(local));
  }

  /* ---------------- Build sliders ---------------- */
  const slidersEl = document.getElementById('sliders');
  PARAMS.forEach(p=>{
    const row = document.createElement('div');
    row.className='slider-row';
    row.innerHTML = `
      <div class="slider-head"><span class="name">${p.label}</span><span class="val" id="val-${p.key}"></span></div>
      <div class="slider-track-wrap">
        <div class="slider-bg" id="bg-${p.key}"></div>
        <input type="range" id="in-${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.def}">
      </div>
      <div class="slider-scale"><span>${p.min}${p.unit?(' '+p.unit):''}</span><span>${p.max}${p.unit?(' '+p.unit):''}</span></div>
    `;
    slidersEl.appendChild(row);

    const pct = (v)=> ((v-p.min)/(p.max-p.min))*100;
    let grad;
    if(p.key==='ph'){
      grad = `linear-gradient(90deg, rgba(239,91,91,.45) 0%, rgba(239,91,91,.45) ${pct(p.safeMin)}%, rgba(62,207,142,.45) ${pct(p.safeMin)}%, rgba(62,207,142,.45) ${pct(p.safeMax)}%, rgba(239,91,91,.45) ${pct(p.safeMax)}%, rgba(239,91,91,.45) 100%)`;
    } else {
      grad = `linear-gradient(90deg, rgba(62,207,142,.45) 0%, rgba(62,207,142,.45) ${pct(p.safeMax)}%, rgba(239,91,91,.45) ${pct(p.safeMax)}%, rgba(239,91,91,.45) 100%)`;
    }
    document.getElementById('bg-'+p.key).style.background = grad;

    document.getElementById('in-'+p.key).addEventListener('input', (e)=>{
      raw[p.key] = parseFloat(e.target.value);
      document.getElementById('val-'+p.key).textContent = fmt(p, raw[p.key]);
      if(!isRunning && !before){ current[p.key]=raw[p.key]; renderSensors(); renderTanks(0); }
    });
    document.getElementById('val-'+p.key).textContent = fmt(p, p.def);
  });

  /* ---------------- Sensor cards ---------------- */
  const sensorGrid = document.getElementById('sensorGrid');
  PARAMS.forEach(p=>{
    const card = document.createElement('div');
    card.className='sensor-card st-unsafe';
    card.id='card-'+p.key;
    card.innerHTML = `
      <div class="sensor-name">${p.label}</div>
      <div class="sensor-val"><span id="sv-${p.key}">--</span><span class="unit">${p.unit}</span></div>
      <div class="sensor-bar"><div class="sensor-bar-fill" id="sb-${p.key}"></div></div>
      <span class="sensor-badge" id="sbadge-${p.key}">--</span>
    `;
    sensorGrid.appendChild(card);
  });

  function statusFor(p, v){
    const safe = isSafe(p,v);
    if(safe) return 'safe';
    if(isRunning) return 'treating';
    return 'unsafe';
  }

  function renderSensors(){
    let anyUnsafe=false, allSafe=true;
    PARAMS.forEach(p=>{
      const v=current[p.key];
      const st=statusFor(p,v);
      if(st!=='safe') allSafe=false;
      if(st==='unsafe') anyUnsafe=true;
      document.getElementById('sv-'+p.key).textContent = v.toFixed(p.dec);
      const card=document.getElementById('card-'+p.key);
      card.className='sensor-card st-'+st;
      const badge=document.getElementById('sbadge-'+p.key);
      badge.textContent = st==='safe'?'SAFE':st==='treating'?'TREATING':'UNSAFE';
      const barPct = clamp((v/p.max)*100,2,100);
      const bar=document.getElementById('sb-'+p.key);
      bar.style.width=barPct+'%';
      bar.style.background = st==='safe' ? 'var(--green)' : st==='treating' ? 'var(--amber)' : 'var(--red)';
    });

    const pill=document.getElementById('overallStatus');
    if(isRunning){
      pill.className='status-pill treating'; pill.textContent='TREATING · IN PROGRESS';
    } else if(before && !isRunning && progressOf()>=1){
      pill.className='status-pill safe'; pill.textContent='PURIFIED WATER · SAFE';
    } else {
      const safeNow = PARAMS.every(p=>isSafe(p,current[p.key]));
      pill.className='status-pill '+(safeNow?'safe':'unsafe');
      pill.textContent = safeNow? 'RAW WATER · WITHIN LIMITS' : 'RAW WATER · UNSAFE';
    }
  }

  function progressOf(){
    if(!isRunning && !isPaused) return before? 1: 0;
    const elapsed = isPaused? pausedElapsed : (performance.now()-startTime+pausedElapsed);
    return clamp(elapsed/DURATION,0,1);
  }

  /* ---------------- Tanks / progress / stage engage ---------------- */
  function dirtiness(){
    let score=0,n=0;
    ['turbidity','tds','iron','arsenic','fluoride'].forEach(k=>{
      const p=PARAMS.find(x=>x.key===k);
      score += clamp(raw[k]/p.max,0,1); n++;
    });
    return score/n;
  }
  function rawTankColor(){
    const d=dirtiness();
    const r=Math.round(lerp(120,90,d)), g=Math.round(lerp(160,70,d)), b=Math.round(lerp(190,40,d));
    return `rgb(${r},${g},${b})`;
  }

  function renderTanks(progress){
    document.getElementById('fillRaw').style.height='82%';
    document.getElementById('fillRaw').style.background = rawTankColor();
    document.getElementById('levelRaw').textContent = isRunning||before ? (progress<1?'FEEDING':'DRAWN') : 'READY';

    const cleanH = Math.round(progress*90);
    document.getElementById('fillClean').style.height=cleanH+'%';
    document.getElementById('fillClean').style.background = 'linear-gradient(180deg, #6fe3f2, #1c8fa0)';
    document.getElementById('levelClean').textContent = cleanH>3 ? cleanH+'%' : '';

    Object.keys(STAGE_ENGAGE).forEach(stage=>{
      const box = document.querySelector(`[data-stage="${stage}"]`);
      const engaged = (isRunning||isPaused||progress>=1) && progress>=STAGE_ENGAGE[stage];
      if(box) box.classList.toggle('engaged', !!engaged);
    });

    const scaleEl=document.getElementById('machineScale');
    scaleEl.classList.toggle('running', isRunning && !isPaused);

    const label = progress<=0 ? 'Idle' :
      progress<0.25 ? 'Sediment filtration' :
      progress<0.5 ? 'Activated carbon adsorption' :
      progress<0.75 ? 'RO / UF membrane treatment' :
      progress<1 ? 'Storing in clean tank' : 'Complete';
    document.getElementById('stageLabel').textContent = isPaused? label+' (paused)' : label;
    document.getElementById('progressPct').textContent = Math.round(progress*100)+'%';
    document.getElementById('progressFill').style.width = (progress*100)+'%';
  }

  /* ---------------- Compare strip ---------------- */
  const compareStrip = document.getElementById('compareStrip');
  function renderCompare(){
    compareStrip.innerHTML='';
    PARAMS.forEach(p=>{
      const b = before ? before[p.key] : raw[p.key];
      const a = current[p.key];
      const improved = before ? (isSafe(p,a) && !isSafe(p,b)) || (isSafe(p,a) && isSafe(p,b)) : false;
      const div=document.createElement('div');
      div.className='cmp-card';
      div.innerHTML = `<div class="cmp-name">${p.label}</div>
        <div class="cmp-vals">
          <span class="cmp-before">${b.toFixed(p.dec)}</span>
          <span class="cmp-arrow">→</span>
          <span class="${before? (isSafe(p,a)?'cmp-after':'cmp-before') : 'cmp-arrow'}">${a.toFixed(p.dec)}</span>
        </div>`;
      compareStrip.appendChild(div);
    });
  }

  /* ---------------- Particles ---------------- */
  const PIPE_SPECS = [
    {id:'pipeA', color:'#c99a5b', rate:150, size:5, life:0},
    {id:'pipeB', color:'#d8c07f', rate:220, size:4.5, life:0},
    {id:'pipeC', color:'#a9d6e0', rate:320, size:4, life:0},
    {id:'pipeD', color:'#dff8fb', rate:600, size:3, life:0},
  ];
  function spawnParticle(spec){
    const pipe=document.getElementById(spec.id);
    if(!pipe) return;
    const w = pipe.clientWidth || 60;
    const dot=document.createElement('div');
    dot.className='particle';
    const top = 20+Math.random()*60;
    dot.style.top=top+'%';
    dot.style.width=spec.size+'px'; dot.style.height=spec.size+'px';
    dot.style.background=spec.color;
    dot.style.boxShadow='0 0 4px '+spec.color;
    pipe.appendChild(dot);
    const dur = 900+Math.random()*500;
    requestAnimationFrame(()=>{
      dot.style.transitionDuration=dur+'ms';
      dot.style.left=(w+8)+'px';
    });
    setTimeout(()=>dot.remove(), dur+80);
  }
  function startParticles(){
    stopParticles();
    PIPE_SPECS.forEach(spec=>{
      const t=setInterval(()=>spawnParticle(spec), spec.rate);
      particleTimers.push(t);
    });
  }
  function stopParticles(){
    while(particleTimers.length) clearInterval(particleTimers.pop());
  }

  /* ---------------- Alerts ---------------- */
  const alertList = document.getElementById('alertList');
  function addAlert(type, text){
    const empty=document.getElementById('alertEmpty');
    if(empty) empty.remove();
    const el=document.createElement('div');
    el.className='alert-item '+type;
    const t=new Date().toLocaleTimeString();
    el.innerHTML = `${text}<span class="alert-time">${t}</span>`;
    alertList.prepend(el);
  }
  function checkContaminationAlerts(){
    const critical = PARAMS.filter(p=>['iron','arsenic','fluoride'].includes(p.key) && !isSafe(p, raw[p.key]));
    if(critical.length===0) return;
    const names = critical.map(p=>p.label).join(', ');
    addAlert('warning', `⚠ High ${names} detected in raw water — exceeds BIS safe limit.`);
    setTimeout(()=>addAlert('success', '📩 SMS / App alert sent to Panchayat Office ✓'), 1000);
    setTimeout(()=>addAlert('success', '📩 SMS / App alert sent to PHED Officer ✓'), 1700);
  }

  /* ---------------- Stage info panel ---------------- */
  const stageInfo = document.getElementById('stageInfo');
  document.querySelectorAll('[data-stage]').forEach(el=>{
    el.addEventListener('click', ()=>selectStage(el.dataset.stage));
    el.addEventListener('keydown', (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); selectStage(el.dataset.stage);} });
  });
  function selectStage(stage){
    document.querySelectorAll('[data-stage]').forEach(el=>el.classList.toggle('selected', el.dataset.stage===stage));
    const d = STAGE_DESCRIPTIONS[stage];
    stageInfo.innerHTML = `<b>${d.name}</b> — ${d.text}`;
    selectedStage=stage;
  }

  /* ---------------- Zoom ---------------- */
  const machineScale = document.getElementById('machineScale');
  function applyZoom(){ machineScale.style.transform=`scale(${zoom})`; document.getElementById('zoomReset').textContent=Math.round(zoom*100)+'%'; }
  document.getElementById('zoomIn').addEventListener('click', ()=>{ zoom=clamp(zoom+0.1,0.6,1.6); applyZoom(); });
  document.getElementById('zoomOut').addEventListener('click', ()=>{ zoom=clamp(zoom-0.1,0.6,1.6); applyZoom(); });
  document.getElementById('zoomReset').addEventListener('click', ()=>{ zoom=1; applyZoom(); });
  document.getElementById('machineViewport').addEventListener('wheel', (e)=>{
    if(!e.ctrlKey) return; e.preventDefault();
    zoom=clamp(zoom + (e.deltaY<0?0.08:-0.08),0.6,1.6); applyZoom();
  }, {passive:false});

  /* ---------------- Main loop ---------------- */
  function tick(){
    const progress = progressOf();
    PARAMS.forEach(p=> current[p.key]=valueAt(p,progress) );
    renderSensors(); renderTanks(progress); renderCompare();
    if(progress>=1){ finish(); return; }
    rafId = requestAnimationFrame(tick);
  }

  function finish(){
    isRunning=false; isPaused=false;
    stopParticles();
    document.getElementById('machineScale').classList.remove('running');
    PARAMS.forEach(p=> current[p.key]=checkpoints[p.key][4] );
    renderSensors(); renderTanks(1); renderCompare();
    addAlert('info', '✅ Purification cycle complete — water quality verified SAFE for distribution.');
    startBtn.textContent='Run again';
    startBtn.classList.remove('pause');
  }

  const startBtn = document.getElementById('startBtn');
  const resetBtn = document.getElementById('resetBtn');

  startBtn.addEventListener('click', ()=>{
    if(!isRunning && !isPaused){
      // fresh start (or run again after completion)
      before = {...raw};
      current = {...raw};
      checkpoints = computeCheckpoints(raw);
      pausedElapsed=0; startTime=performance.now();
      isRunning=true; isPaused=false;
      startBtn.textContent='Pause';
      startBtn.classList.add('pause');
      startParticles();
      checkContaminationAlerts();
      addAlert('info', '▶ Purification cycle started.');
      cancelAnimationFrame(rafId);
      tick();
    } else if(isRunning && !isPaused){
      // pause
      isPaused=true; isRunning=false;
      pausedElapsed += performance.now()-startTime;
      cancelAnimationFrame(rafId);
      stopParticles();
      document.getElementById('machineScale').classList.remove('running');
      renderTanks(progressOf());
      startBtn.textContent='Resume';
      startBtn.classList.remove('pause');
    } else if(isPaused){
      // resume
      isPaused=false; isRunning=true;
      startTime=performance.now();
      startBtn.textContent='Pause';
      startBtn.classList.add('pause');
      startParticles();
      cancelAnimationFrame(rafId);
      tick();
    }
  });

  resetBtn.addEventListener('click', ()=>{
    isRunning=false; isPaused=false; before=null;
    pausedElapsed=0; cancelAnimationFrame(rafId);
    stopParticles();
    document.getElementById('machineScale').classList.remove('running');
    current = {...raw};
    startBtn.textContent='Start purification';
    startBtn.classList.remove('pause');
    alertList.innerHTML = '<p class="alert-empty" id="alertEmpty">No alerts yet.</p>';
    stageInfo.innerHTML = '<p class="stage-info-placeholder">Select a stage above to see how it works.</p>';
    document.querySelectorAll('[data-stage]').forEach(el=>el.classList.remove('selected','engaged'));
    renderSensors(); renderTanks(0); renderCompare();
  });

  /* ---------------- Init ---------------- */
  renderSensors();
  renderTanks(0);
  renderCompare();
  applyZoom();
})();
