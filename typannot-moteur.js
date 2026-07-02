/* ============================================================
   TYPANNOT — MOTEUR MULTI-PAGES — v4.1 (accès debug modèle)
   Hébergé en externe (jsDelivr / GitHub).
   Un seul moteur pour les 5 pages (finger, upper limb, lowerface,
   body, upperface). Démarre sur 'groups-ready'.

   NOUVEAU v4 (généralisation "chaîne d'ancres") :
   - détection du niveau 'subselection' + normalisation des titres
     ("Sub Part"/"Sub part"/"Subselection"/"Sub selection")
   - chaque case connaît sa CHAÎNE D'ANCRES complète
     (part > selection > sub part > subselection selon la page)
   - clic sur une value injecte TOUTE la chaîne d'ancres manquante
     (ex. corner-left -> lips + corner + left ; eyelids -> 4 niveaux)
   - mapping clavier 'info-subselection'
   - gardes anti-crash sur les cases sans syntax_text
   Conserve tout le comportement finger (v3.6) à l'identique.
   Debug console : window.typannotJournal()
   ============================================================ */


/* ====================================================================
   MOTEUR STATELESS v6 — proto finger
   --------------------------------------------------------------------
   Principe : à CHAQUE changement de la valeur de l'input, on relit toute
   la chaîne, on reconstruit la formule de zéro en rejouant chaque glyph,
   et on identifie la première incohérence (racine).

   - frappe clavier : ajoute le glyph à la fin de l'input -> déclenche revalidation
   - édition manuelle (delete milieu, backspace, etc.) : événement 'input' -> revalidation

   Règles (validées) :
   - part obligatoire (ancrage) : subpart/subvar/value sans part -> need_part
   - subpart obligatoire pour atteindre subvar/value -> need_subpart
   - variable skippable
   - subvar->value strict ; value sans subvar -> need_subvar ; subvar sans value OK
   - paire ref/zero : auto-remplissage + complément sur place
   - cascade ref/zero : niveau part (doigt entier) ou subpart
   ==================================================================== */
function startTypannotEngine(){
  // garde anti double-démarrage
  if(window.__typannotEngineStarted) return;
  window.__typannotEngineStarted = true;

  // alias : le moteur lit la variable globale GROUPS (fournie par le bloc CSV : window.GROUPS)
  var GROUPS = window.GROUPS;

  const formulaEl = document.querySelector('.framework.small_layout') || document.getElementById('formula');
  const inputEl   = document.getElementById('input-field');
  const logEl     = document.getElementById('log'); // peut être null sur le site

  const G_REFPOS = '\uf47c';
  const G_ZERO   = '\ue5ef';

  // Modèle statique des cases (structure, ne change jamais)
  // ==== ADAPTATION SITE : construire le modèle depuis .value_wrap/.syntax_text ====
  function kindFromTitle(title){
    // normaliser : minuscules + espaces multiples réduits (tolère "Sub Part"/"Sub part"/"Subselection")
    const t = (title||'').toLowerCase().replace(/\s+/g,' ').trim();
    if(t.startsWith('descriptive dimension') || t === 'posture') return 'posture';
    if(t.startsWith('as:')) return 'as';
    if(t.startsWith('class:')) return 'class';
    if(t.startsWith('part:')) return 'part';
    if(t.startsWith('sub part:')) return 'sub part';
    // subselection AVANT selection (car "sub selection" contient "selection")
    if(t.startsWith('sub selection') || t.startsWith('subselection')) return 'subselection';
    if(t.startsWith('variable:')) return 'variable';
    if(t.startsWith('sub variable')) return 'sub variable';
    if(t.startsWith('value:')) return 'value';
    if(t.startsWith('ponctuation:')) return 'ponctuation';
    if(t.startsWith('selection')) return 'selection';
    return '?';
  }
  function kindFromDataOptions(opt){
    if(opt.startsWith('selection-')) return 'selection';
    if(opt.startsWith('subvar-')) return 'sub variable';
    if(opt.startsWith('value-')) return 'value';
    return '?';
  }
  // Niveau hiérarchique d'une ancre (étiquette fixe qui précède un bloc).
  // part < selection < sub part < subselection. Les non-ancres renvoient 0.
  function anchorLevel(kind){
    switch(kind){
      case 'part': return 1;
      case 'selection': return 2;
      case 'sub part': return 3;
      case 'subselection': return 4;
      default: return 0;
    }
  }
  function isAnchorKind(kind){ return anchorLevel(kind) > 0; }
  // nom lisible extrait d'un title "Kind: name" -> "name"
  function nameFromTitle(title){
    const m = (title||'').split(':');
    return m.length>1 ? m.slice(1).join(':').trim() : (title||'').trim();
  }
  const CASES = [];
  formulaEl.querySelectorAll('.framework_wrap').forEach(fw => {
    // pile d'ancres courantes DANS ce framework_wrap (réinitialisée à chaque wrap)
    // chaque entrée : {level, kind, name, glyph, caseIdx}
    let anchorStack = [];
    Array.from(fw.children).forEach(child => {
      if(!child.classList || !child.classList.contains('value_wrap')) return;
      const dataOptions = child.getAttribute('data-options');
      const mainSt = child.querySelector(':scope > .syntax_text');
      const title = mainSt ? mainSt.getAttribute('title') : '';
      let kind, fixedGlyph = null;
      if(dataOptions){
        kind = kindFromDataOptions(dataOptions);
      } else {
        kind = kindFromTitle(title);
        fixedGlyph = mainSt ? mainSt.textContent : null;
      }
      const idx = CASES.length;
      // mise à jour de la pile d'ancres : une ancre de niveau L retire toutes les
      // ancres de niveau >= L (on change de branche) puis s'empile. Une part (L1)
      // remet la pile à zéro. Ponctuation (part end) vide la pile.
      if(kind === 'ponctuation'){
        anchorStack = [];
      } else if(isAnchorKind(kind)){
        const L = anchorLevel(kind);
        anchorStack = anchorStack.filter(a => a.level < L);
        anchorStack.push({level:L, kind:kind, name:nameFromTitle(title), glyph:fixedGlyph, caseIdx:idx});
      }
      // chaîne d'ancres de CETTE case = copie de la pile courante
      // (pour une ancre, sa chaîne inclut elle-même ; pour un bloc, ce sont ses ancres parentes)
      const anchorChain = anchorStack.map(a => ({level:a.level, kind:a.kind, name:a.name, glyph:a.glyph, caseIdx:a.caseIdx}));
      CASES.push({
        idx: idx,
        el: child,
        span: mainSt,
        kind: kind,
        dataOptions: dataOptions || null,
        title: title,
        name: nameFromTitle(title),
        fixedGlyph: fixedGlyph,
        anchorChain: anchorChain,
        initialGlyph: mainSt ? mainSt.textContent : ''
      });
    });
  });

  function isInteractive(c){ return c.dataOptions != null; }
  // signature d'identité d'un bloc/case = sa chaîne d'ancres (glyphes) + variable au-dessus.
  // Deux cases interactives sont dans des blocs différents si leur signature diffère.
  function anchorSignature(caseIdx){
    const c = CASES[caseIdx];
    if(!c) return '';
    return c.anchorChain.map(a => a.level+':'+(a.glyph||a.name)).join('|');
  }

  // Table glyph -> kind, construite depuis le CLAVIER (source de vérité fiable :
  // chaque touche appartient à une catégorie, même si le glyph n'est pas dans la formule).
  const KEYBOARD_KIND = {};
  (function(){
    const map = {'info-descdim':'descriptive dimension','info-as':'as','info-selection':'selection',
                 'info-subselection':'subselection',
                 'info-part':'part','info-subpart':'sub part','info-variable':'variable',
                 'info-subvariable':'sub variable','info-value':'value','info-ponct':'ponctuation'};
    document.querySelectorAll('.key').forEach(btn => {
      const g = btn.getAttribute('data-value');
      const cont = btn.getAttribute('data-container');
      if(g && map[cont]) KEYBOARD_KIND[g] = map[cont];
    });
  })();
  function log(m){ if(!logEl) return; logEl.textContent += m + "\n"; logEl.scrollTop = logEl.scrollHeight; }

  // ---------- LE VALIDATEUR : rejoue une séquence, renvoie l'état ----------
  function validate(glyphs, caseIds){
    caseIds = caseIds || [];
    // état frais : pour chaque case, {filled, glyph, typed}
    const st = CASES.map(c => ({filled:false, glyph:c.fixedGlyph, typed:false, srcChar:-1, isUndef:false}));
    let cursor = -1;
    const errors = [];

    function gMatch(glyph, i){
      const c = CASES[i];
      if(isInteractive(c)){
        const opts = GROUPS[c.dataOptions]||[];
        return opts.some(o=>o.glyph===glyph && o.label!=='undefined');
      } else {
        return c.fixedGlyph === glyph;
      }
    }
    // matche AUSSI l'option undefined (undefined est un contenu valide de la case)
    function gMatchUndef(glyph, i){
      const c = CASES[i];
      if(isInteractive(c)){
        const opts = GROUPS[c.dataOptions]||[];
        return opts.some(o=>o.glyph===glyph);
      }
      return false;
    }
    // ce glyphe est-il l'undefined d'un groupe interactif ?
    function isUndefGlyph(glyph, i){
      const c = CASES[i];
      if(!isInteractive(c)) return false;
      const opts = GROUPS[c.dataOptions]||[];
      return opts.some(o=>o.glyph===glyph && o.label==='undefined');
    }
    // kind d'un glyph (pour distinguer 'mauvaise valeur' de 'mauvais type')
    function glyphKindLocal(g){
      if(KEYBOARD_KIND[g]) return KEYBOARD_KIND[g];  // source fiable (clavier)
      for(const c of CASES){ if(c.fixedGlyph===g) return c.kind; }
      for(const c of CASES){
        if(isInteractive(c)){
          const opts=GROUPS[c.dataOptions]||[];
          if(opts.some(o=>o.glyph===g && o.label!=='undefined')) return c.kind;
        }
      }
      return '?';
    }
    function pairedValueOf(subIdx){
      for(let k=subIdx+1;k<CASES.length;k++){
        if(CASES[k].kind==='value'&&isInteractive(CASES[k]))return k;
        if(CASES[k].kind==='sub variable')return -1;
        if(CASES[k].kind==='part'||CASES[k].kind==='sub part')return -1;
      } return -1;
    }
    function pairedSubOf(valIdx){
      for(let k=valIdx-1;k>=0;k--){
        if(CASES[k].kind==='sub variable'&&isInteractive(CASES[k]))return k;
        if(CASES[k].kind==='value')return -1;
      } return -1;
    }
    function partName(i){ const m=CASES[i].title.split(':'); return m.length>1?m[1].trim():CASES[i].title.trim(); }
    function blocksInWholeFinger(partIdx){
      const name=partName(partIdx); const blocks=[]; let k=partIdx;
      while(k<CASES.length){
        if(CASES[k].kind==='part'&&partName(k)===name){
          for(let m=k+1;m<CASES.length;m++){
            const ck=CASES[m].kind;
            if(ck==='part'){k=m;break;}
            if(ck==='ponctuation'){k=m+1;break;}
            if(ck==='sub variable'&&isInteractive(CASES[m]))blocks.push({sub:m,val:null});
            if(ck==='value'&&isInteractive(CASES[m])&&blocks.length)blocks[blocks.length-1].val=m;
            if(m===CASES.length-1){k=m+1;}
          }
          if(k<CASES.length&&CASES[k].kind==='part'&&partName(k)===name)continue; else break;
        } else break;
      }
      return blocks;
    }
    function blocksInAllFingers(){
      // TOUS les blocs (subvar interactive + sa value) de TOUTE la formule.
      const blocks=[];
      for(let k=0;k<CASES.length;k++){
        const ck=CASES[k].kind;
        if(ck==='sub variable'&&isInteractive(CASES[k]))blocks.push({sub:k,val:null});
        if(ck==='value'&&isInteractive(CASES[k])&&blocks.length){
          const last=blocks[blocks.length-1];
          if(last.val==null)last.val=k;
        }
      }
      return blocks;
    }
    function blocksInSubpart(subIdx){
      const blocks=[];
      for(let k=subIdx+1;k<CASES.length;k++){
        const ck=CASES[k].kind;
        if(ck==='sub part'||ck==='part'||ck==='ponctuation')break;
        if(ck==='sub variable'&&isInteractive(CASES[k]))blocks.push({sub:k,val:null});
        if(ck==='value'&&isInteractive(CASES[k])&&blocks.length)blocks[blocks.length-1].val=k;
      }
      return blocks;
    }
    function endOfFingerIdx(partIdx){
      const name=partName(partIdx);let last=partIdx;
      for(let k=partIdx;k<CASES.length;k++){
        if(CASES[k].kind==='part'&&partName(k)===name){last=k;continue;}
        if(CASES[k].kind==='part'&&partName(k)!==name)break;
        last=k;
      } return last;
    }
    function endOfSubpartIdx(subIdx){
      let last=subIdx;
      for(let k=subIdx+1;k<CASES.length;k++){
        const ck=CASES[k].kind;
        if(ck==='sub part'||ck==='part'||ck==='ponctuation')break;
        last=k;
      } return last;
    }
    function cascadeFill(blocks, gi){
      const f=[];
      blocks.forEach(b=>{
        if(b.sub!=null&&!st[b.sub].filled){st[b.sub].filled=true;st[b.sub].glyph=G_REFPOS;st[b.sub].srcChar=gi;f.push(b.sub);}
        if(b.val!=null&&!st[b.val].filled){st[b.val].filled=true;st[b.val].glyph=G_ZERO;st[b.val].srcChar=gi;f.push(b.val);}
      });
      return f;
    }
    function partTypedBeforeCursor(){
      for(let k=cursor;k>=0;k--){
        if(CASES[k].kind==='ponctuation'&&st[k].typed)return false;
        if(CASES[k].kind==='part'&&st[k].typed)return true;
      } return false;
    }
    function findForward(glyph, forcedCaseId){
      // Si le rec porte un caseId (glyphe posé via la formule sur un bloc précis), on FORCE
      // le placement dans la case exacte dont dataOptions === caseId. Le rec est la frontiere :
      // le validateur ne devine plus, il respecte l'origine.
      if(forcedCaseId != null){
        // chercher la case cible en ABSOLU (le caseId désigne un bloc précis, pas relatif au curseur)
        for(let j=0;j<CASES.length;j++){
          if(CASES[j].dataOptions === forcedCaseId && !st[j].filled){
            const c=CASES[j];
            // RESPECTER la règle subvar->value : si on cible une VALUE dont la subvar (j-1)
            // n'est pas remplie -> need_subvar (génère le ◌), comme la logique normale.
            if(c.kind==='value'){
              const ps=CASES[j-1];
              if(ps && ps.kind==='sub variable' && !st[j-1].filled){
                return{err:'need_subvar', target:j-1};
              }
            }
            return{idx:j};
          }
        }
        // case cible déjà remplie ou introuvable : laisser la logique normale décider
      }
      let cuP=false,cuSP=false;
      const hadPart=partTypedBeforeCursor();
      // nom du doigt courant (dernière part tapée avant le curseur)
      let curFinger=null;
      for(let k=cursor;k>=0;k--){
        if(CASES[k].kind==='ponctuation'&&st[k].typed){break;}
        if(CASES[k].kind==='part'&&st[k].typed){curFinger=partName(k);break;}
      }
      for(let j=cursor+1;j<CASES.length;j++){
        const c=CASES[j];
        if(c.kind==='value'&&isInteractive(c)&&!st[j].filled){
          const ps=CASES[j-1];
          // UNDEFINED en value : toujours accepté (contenu neutre), quelle que soit la subvar.
          if(isUndefGlyph(glyph,j)){ return{idx:j, undef:true}; }
          const subFilledReal = ps && ps.kind==='sub variable' && st[j-1].filled && !st[j-1].isUndef;
          const subFilledUndef = ps && ps.kind==='sub variable' && st[j-1].filled && st[j-1].isUndef;
          if(subFilledReal){
            if(gMatch(glyph,j))return{idx:j};
            if(glyphKindLocal(glyph)==='value'){ return{err:"bad_value", target:j}; }
            return{err:'value_due', target:j};
          }
          // subvar UNDEFINED (ou vide) + vraie value -> faute : vraie value exige vraie subvar
          if((subFilledUndef || (ps&&ps.kind==='sub variable'&&!st[j-1].filled))){
            if(gMatch(glyph,j))return{err:'need_subvar', target:j-1};
          }
        }
        // UNDEFINED en subvar libre : accepté (contenu neutre)
        if(c.kind==='sub variable'&&isInteractive(c)&&!st[j].filled&&isUndefGlyph(glyph,j)){
          return{idx:j, undef:true};
        }
        if(gMatch(glyph,j)){
          // Part identique au doigt courant sans contenu codé entre = faute (doublon)
          if(c.kind==='part' && curFinger!==null && partName(j)===curFinger){
            // a-t-on rempli au moins une case interactive dans le doigt courant ?
            let hasContent=false;
            for(let k=0;k<j;k++){
              if(isInteractive(CASES[k]) && st[k].filled){
                // appartient au doigt courant ?
                for(let p=k;p>=0;p--){ if(CASES[p].kind==='part'){ if(partName(p)===curFinger)hasContent=true; break; } }
                if(hasContent)break;
              }
            }
            if(!hasContent) return{err:'no_match'};
          }
          if(c.kind==='sub part'){
            if(cuP||!hadPart)return{err:'need_part', target:j};
          }
          if(c.kind==='sub variable'||c.kind==='value'){
            if(cuSP)return{err:'need_subpart', target:j};
            if(cuP)return{err:'need_part', target:j};
            if(!hadPart&&!cuP)return{err:'need_part', target:j};
          }
          return{idx:j};
        }
        if(c.kind==='part'){
          if(curFinger!==null&&partName(j)===curFinger){
            /* même doigt: segment couvert, ne pas marquer cuP */
          } else {
            cuP=true; cuSP=false;
          }
        }
        if(c.kind==='sub part')cuSP=true;
      }
      return{err:'no_match'};
    }

    // rejouer
    let retryCount = 0;
    for(let gi=0; gi<glyphs.length; gi++){
      const glyph=glyphs[gi];

      // complément paire sur place
      if(cursor>=0){
        const cc=CASES[cursor];
        if(cc.kind==='value'&&isInteractive(cc)&&st[cursor].filled){
          const subK=pairedSubOf(cursor);
          if(subK>=0&&st[subK].filled){
            if(st[subK].glyph===G_REFPOS&&st[cursor].glyph===G_ZERO&&(glyph===G_REFPOS||glyph===G_ZERO)){
              continue;
            }
          }
        }
      }

      // cascade
      if(glyph===G_REFPOS||glyph===G_ZERO){
        const lc=cursor>=0?CASES[cursor]:null;
        // NIVEAU AS/HAND : ref pos/zero juste après selection ou AS (finger) ->
        // remplir TOUS les blocs de TOUS les doigts avec les couples ref pos + zero linkés.
        if(lc&&(lc.kind==='selection'||lc.kind==='as')){
          const blocks=blocksInAllFingers();
          if(blocks.length){
            const f=cascadeFill(blocks, gi);
            const mx=Math.max.apply(null,f);
            if(mx>cursor)cursor=mx;
            continue;
          }
        }
        if(lc&&lc.kind==='part'){
          const blocks=blocksInWholeFinger(cursor);
          if(blocks.length){
            const f=cascadeFill(blocks, gi);
            cursor=endOfFingerIdx(cursor);
            const mx=Math.max.apply(null,f); if(mx>cursor)cursor=mx;
            continue;
          }
        }
        if(lc&&lc.kind==='sub part'){
          const blocks=blocksInSubpart(cursor);
          if(blocks.length){
            const f=cascadeFill(blocks, gi);
            const mx=Math.max.apply(null,f);
            cursor=Math.max(endOfSubpartIdx(cursor),mx);
            continue;
          }
        }
      }

      const res=findForward(glyph, caseIds[gi]);
      if(res.err){
        // MULTI-ERREUR : enregistrer l'erreur et CONTINUER (skip du glyph fautif).
        errors.push({at:gi, kind:res.err, target:(res.target!=null?res.target:-1)});
        // Avancer le curseur pour que le prochain glyph soit correctement ciblé :
        // pour une value orpheline (need_subvar), on marque la value visée comme
        // "occupée" par ce glyph et on avance au-delà, afin que la value suivante
        // cherche dans un bloc ultérieur.
        if(res.err === 'need_subvar' && res.target != null){
          // res.target = case subvar ; la value du bloc est juste après (target+1).
          const valCase = res.target + 1;
          if(CASES[valCase] && CASES[valCase].kind === 'value'){
            // marquer provisoirement pour placement (srcChar = ce glyph)
            st[valCase].filled = true; st[valCase].glyph = glyph; st[valCase].srcChar = gi;
            cursor = valCase;
          }
          continue;
        } else if(res.err === 'value_due' && res.target != null && res.target > cursor && retryCount < 3){
          // value manquante (subvar filled sans value) et le glyphe courant veut aller
          // AILLEURS (ex: nouvelle part). Avancer le curseur au-delà du bloc et RÉESSAYER
          // le glyphe courant (ne pas le perdre). Garde-fou : max 3 réessais + curseur avance.
          cursor = res.target;
          retryCount++;
          gi--; // réessayer le même glyphe avec le curseur avancé
          continue;
        } else if(res.target != null && res.target > cursor){
          cursor = res.target;
          continue;
        } else {
          continue;
        }
      }
      const j=res.idx; const c=CASES[j];
      if(isInteractive(c)){
        st[j].filled=true; st[j].glyph=glyph; st[j].srcChar=gi; st[j].isUndef=!!res.undef;
        if(c.kind==='sub variable'&&glyph===G_REFPOS){
          const vK=pairedValueOf(j);
          if(vK>=0&&!st[vK].filled){st[vK].filled=true;st[vK].glyph=G_ZERO;st[vK].srcChar=gi;cursor=vK;continue;}
        }
        if(c.kind==='value'&&glyph===G_ZERO){
          const sK=pairedSubOf(j);
          if(sK>=0&&!st[sK].filled){st[sK].filled=true;st[sK].glyph=G_REFPOS;st[sK].srcChar=gi;}
        }
      } else {
        st[j].typed=true; st[j].srcChar=gi;
      }
      cursor=j;
    }
    // rétrocompat : errorAt/Kind/Target = la PREMIÈRE erreur (ou -1 si aucune)
    const first = errors.length ? errors[0] : null;
    return {
      st,
      errors: errors,
      errorAt: first ? first.at : -1,
      errorKind: first ? first.kind : null,
      errorTarget: first ? first.target : -1
    };
  }

  // ---------- APPLIQUER l'état à l'affichage de la formule ----------
  function render(result){
    const {st} = result;
    const glyphs = result._glyphs || [];
    const errs = result.errors || (result.errorAt >= 0 ? [{at:result.errorAt, kind:result.errorKind, target:result.errorTarget}] : []);

    // 1. Pour CHAQUE erreur, calculer les impactés (orange + repaired). On FUSIONNE les états.
    const mergedDisplaySt = st.map(s => Object.assign({}, s)); // copie
    const orangeSet = new Set();
    const allOrangeSrc = [];
    errs.forEach(e => {
      const subResult = {st:st, errorAt:e.at, errorKind:e.kind, errorTarget:e.target, _glyphs:glyphs};
      const imp = findImpactedCells(glyphs, subResult);
      // fusionner le repairedState : les cases filled par cette réparation
      if(imp.repairedState){
        imp.repairedState.forEach((s,i) => {
          if(s.filled && !mergedDisplaySt[i].filled){
            mergedDisplaySt[i] = Object.assign({}, s);
          }
        });
      }
      (imp.orange||[]).forEach(i => orangeSet.add(i));
      (imp.orangeOrigSrc||[]).forEach(sc => allOrangeSrc.push(sc));
    });
    st.forEach((s,i) => { if(s.orphan && s.srcChar >= 0) allOrangeSrc.push(s.srcChar); });
    result._orangeSrcChars = allOrangeSrc;

    // 2. Afficher les glyphs (avec l'état fusionné)
    CASES.forEach((c,i) => {
      const span = c.span;
      if(!span) return; // case sans syntax_text (structure incomplète) : ignorer, pas de crash
      span.classList.remove('errcell','impactcell','solcell');
      if(isInteractive(c)){
        const filledHere = mergedDisplaySt[i] && mergedDisplaySt[i].filled;
        if(filledHere){
          span.textContent = mergedDisplaySt[i].glyph;
          span.classList.remove('empty'); span.classList.add('filled');
        } else {
          const opts = GROUPS[c.dataOptions]||[];
          const undef = opts.find(o=>o.label==='undefined');
          span.textContent = undef ? undef.glyph : (c.initialGlyph || '');
          span.classList.remove('filled'); span.classList.add('empty');
        }
      }
    });

    // 3. Marquer les erreurs (rouge/bleu) pour CHAQUE erreur
    errs.forEach(e => {
      const subResult = {st:st, errorAt:e.at, errorKind:e.kind, errorTarget:e.target, _glyphs:glyphs};
      markErrorCell(subResult, glyphs);
    });

    // 4. Marquer les impactés (orange) — après, sans écraser rouge/bleu
    orangeSet.forEach(i => {
      if(!CASES[i].span.classList.contains('errcell') && !CASES[i].span.classList.contains('solcell')){
        CASES[i].span.classList.add('impactcell');
      }
    });
    // 4b. Les values orphelines (filled par un skip) -> orange + retirer le vert
    st.forEach((s,i) => {
      if(s.orphan && CASES[i].span){
        CASES[i].span.classList.remove('filled');
        if(!CASES[i].span.classList.contains('errcell') && !CASES[i].span.classList.contains('solcell')){
          CASES[i].span.classList.add('impactcell');
        }
      }
    });
  }

  // Détecte si le glyph fautif est un DOUBLON d'une case déjà remplie/tapée proche
  // en arrière. Retourne l'index de la case à colorer, ou -1.
  function findDuplicateCell(glyphs, result){
    const at = result.errorAt;
    if(at < 0) return -1;
    // un doublon n'a de sens que si l'erreur n'est PAS un manque structurel.
    if(['need_subvar','need_part','need_subpart','value_due'].includes(result.errorKind)) return -1;
    const G = glyphs[at];
    // chercher la case (interactive remplie OU fixe tapée) portant G avec le srcChar
    // le plus proche EN ARRIÈRE de 'at'.
    let best = -1, bestSrc = -2;
    result.st.forEach((s,i) => {
      const cellGlyph = s.filled ? s.glyph : (CASES[i].fixedGlyph);
      const isTypedHere = s.filled || s.typed;
      if(isTypedHere && cellGlyph === G && s.srcChar >= 0 && s.srcChar < at && s.srcChar > bestSrc){
        best = i; bestSrc = s.srcChar;
      }
    });
    return best;
  }

  // Détermine quelle case afficher en rouge : le PREMIER élément sémantique
  // manquant dans la formule, déduit de la case orpheline (errorTarget) + type d'erreur.
  function partNameOf(i){ const m=CASES[i].title.split(':'); return m.length>1?m[1].trim():CASES[i].title.trim(); }

  // ---- Structures pour la détection des candidats multiples ----
  // Glyphs de chaque doigt (part) et de chaque subpart, lus depuis les cases fixes.
  const PART_GLYPHS = {};     // name -> glyph
  const SUBPART_GLYPHS = {};  // name -> glyph
  CASES.forEach(c => {
    if(c.kind==='part' && c.fixedGlyph){
      const pn = partNameOf(c.idx);
      if(!(pn in PART_GLYPHS)) PART_GLYPHS[pn] = c.fixedGlyph; // 1er segment seulement
    }
    if(c.kind==='sub part' && c.fixedGlyph){
      const nm = c.title.split(':').length>1 ? c.title.split(':')[1].trim() : c.title.trim();
      if(!(nm in SUBPART_GLYPHS)) SUBPART_GLYPHS[nm] = c.fixedGlyph;
    }
  });

  // kind d'un glyph (pour analyser la saisie) — via les boutons du clavier
  const GLYPH_KIND = {};
  document.querySelectorAll('.key').forEach(btn => {
    const g = btn.getAttribute('data-value');
    // déduire le kind depuis la catégorie de la touche : on relit le data-container ? 
    // Les boutons n'ont pas data-container ici. On déduit via les cases.
  });
  // Plus robuste : déduire le kind d'un glyph en cherchant une case fixe qui le porte,
  // ou une option interactive qui le contient.
  function glyphKind(g){
    // case fixe ?
    for(const c of CASES){ if(c.fixedGlyph===g) return c.kind; }
    // option interactive ?
    for(const c of CASES){
      if(isInteractive(c)){
        const opts = GROUPS[c.dataOptions]||[];
        if(opts.some(o=>o.glyph===g && o.label!=='undefined')) return c.kind;
      }
    }
    return '?';
  }

  // Trouve la sous-formule orpheline + les candidats compatibles.
  // Retourne { candidateCells: [idx,...] } = cases de la formule à colorer en rouge.
  function findCandidateCells(glyphs, result){
    const kind = result.errorKind;
    const at = result.errorAt;
    if(at < 0) return [];
    if(kind !== 'need_part' && kind !== 'need_subpart'){
      // erreur non ambiguë : une seule case (gérée par markErrorCell classique)
      return null;
    }

    // sous-formule orpheline : depuis 'at' jusqu'à la prochaine frontière part/ponct
    const orphan = [];
    for(let i=at;i<glyphs.length;i++){
      const k = glyphKind(glyphs[i]);
      if(i>at && k==='part') break;
      if(i>at && k==='ponctuation') break;
      orphan.push(glyphs[i]);
    }

    const cells = [];

    if(kind === 'need_part'){
      // tester chaque doigt : préfixer par le glyph du doigt
      for(const [name, pg] of Object.entries(PART_GLYPHS)){
        const test = [pg, ...orphan];
        const r = validate(test);
        if(r.errorAt < 0){
          // candidat valide -> trouver la case 'part' de ce doigt qui est ENCORE LIBRE
          // (premier segment du doigt non rempli). On colore la 1re case part du doigt.
          const cell = firstPartCellOf(name);
          if(cell>=0 && !cellFingerHasContent(name, result)) cells.push(cell);
        }
      }
    } else if(kind === 'need_subpart'){
      // on connaît le doigt (part tapée avant 'at')
      let partGlyph = null;
      for(let i=at-1;i>=0;i--){ if(glyphKind(glyphs[i])==='part'){ partGlyph=glyphs[i]; break; } }
      for(const [name, sg] of Object.entries(SUBPART_GLYPHS)){
        const test = partGlyph ? [partGlyph, sg, ...orphan] : [sg, ...orphan];
        const r = validate(test);
        if(r.errorAt < 0){
          // candidat subpart valide -> colorer la case subpart correspondante
          // (celle du doigt courant). Trouver l'idx de cette subpart dans le doigt courant.
          const cell = subpartCellInCurrentFinger(partGlyph, name, result);
          if(cell>=0) cells.push(cell);
        }
      }
    }
    return cells;
  }

  // 1re case 'part' d'un doigt donné (par nom)
  function firstPartCellOf(name){
    for(let i=0;i<CASES.length;i++){ if(CASES[i].kind==='part' && partNameOf(i)===name) return i; }
    return -1;
  }
  // le doigt a-t-il déjà du contenu rempli ? (pour exclusion)
  function cellFingerHasContent(name, result){
    for(let i=0;i<CASES.length;i++){
      if(CASES[i].kind==='part' && partNameOf(i)===name){
        // parcourir ce segment et les suivants du même doigt
      }
      if(isInteractive(CASES[i]) && result.st[i].filled){
        // appartient-il à ce doigt ? trouver la part au-dessus
        for(let k=i;k>=0;k--){ if(CASES[k].kind==='part'){ if(partNameOf(k)===name) return true; break; } }
      }
    }
    return false;
  }
  // case subpart (par nom) dans le doigt courant identifié par partGlyph
  function subpartCellInCurrentFinger(partGlyph, subName, result){
    // trouver le nom du doigt depuis partGlyph
    let fingerName=null;
    for(const [nm,g] of Object.entries(PART_GLYPHS)){ if(g===partGlyph){ fingerName=nm; break; } }
    if(!fingerName) return -1;
    // trouver la case subpart de ce nom dans un segment de ce doigt, dont le bloc est libre
    for(let i=0;i<CASES.length;i++){
      if(CASES[i].kind==='sub part'){
        const nm = CASES[i].title.split(':').length>1?CASES[i].title.split(':')[1].trim():'';
        if(nm===subName){
          // vérifier que c'est dans le bon doigt
          let belongsTo=null;
          for(let k=i;k>=0;k--){ if(CASES[k].kind==='part'){ belongsTo=partNameOf(k); break; } }
          if(belongsTo===fingerName){
            // vérifier que le bloc de cette subpart est libre (pas déjà rempli)
            if(!subpartHasContent(i, result)) return i;
          }
        }
      }
    }
    return -1;
  }
  function subpartHasContent(subIdx, result){
    for(let k=subIdx+1;k<CASES.length;k++){
      const ck=CASES[k].kind;
      if(ck==='sub part'||ck==='part'||ck==='ponctuation')break;
      if(isInteractive(CASES[k]) && result.st[k].filled) return true;
    }
    return false;
  }


  function markErrorCell(result, glyphs){
    const {errorKind, errorTarget} = result;

    // 0. DOUBLON : si le glyph fautif duplique une case déjà remplie proche en arrière,
    //    colorer cette case (priorité sur tout le reste).
    const dupCell = findDuplicateCell(glyphs, result);
    if(dupCell >= 0){
      if(CASES[dupCell].span) CASES[dupCell].span.classList.add('errcell');
      return;
    }

    // 1. Essayer la détection des CANDIDATS MULTIPLES (need_part / need_subpart)
    const candidateCells = findCandidateCells(glyphs, result);
    if(candidateCells !== null){
      // need_part ou need_subpart = TROU -> solutions en BLEU
      if(candidateCells.length > 0){
        candidateCells.forEach(idx => { if(CASES[idx].span) CASES[idx].span.classList.add('solcell'); });
        return;
      }
      // si aucune candidate trouvée, fallback ci-dessous
    }

    // 2. Erreurs non ambiguës : une seule case
    if(errorTarget == null || errorTarget < 0) return;
    // bad_value : la value est présente mais invalide -> ROUGE sur la case value
    if(errorKind === 'bad_value'){
      if(CASES[errorTarget].span) CASES[errorTarget].span.classList.add('errcell');
      return;
    }
    let cellToMark = -1;
    let isHole = false;  // trou (manque) -> bleu ; sinon rouge
    if(errorKind === 'need_subvar'){ cellToMark = errorTarget; isHole = true; }
    else if(errorKind === 'value_due'){ cellToMark = errorTarget; isHole = true; }
    else if(errorKind === 'need_subpart'){
      isHole = true;
      for(let k=errorTarget-1;k>=0;k--){
        if(CASES[k].kind==='sub part'){ cellToMark=k; break; }
        if(CASES[k].kind==='part'){ break; }
      }
    }
    else if(errorKind === 'need_part'){
      isHole = true;
      for(let k=errorTarget-1;k>=0;k--){
        if(CASES[k].kind==='part'){ cellToMark=k; break; }
      }
    }
    else { cellToMark = errorTarget; }  // no_match -> rouge (faute)
    if(cellToMark >= 0){
      if(CASES[cellToMark].span) CASES[cellToMark].span.classList.add(isHole ? 'solcell' : 'errcell');
    }
  }

  // ---------- ANALYSE DES BRIQUES IMPACTÉES (orange) ----------
  // Quand il y a une erreur structurelle, on "répare temporairement" en réinsérant
  // l'élément manquant, on revalide, et on récupère les cases remplies par la
  // sous-formule orpheline -> ces cases gardent leur glyph et passent en ORANGE.
  function findImpactedCells(glyphs, result){
    if(result.errorAt < 0) return {orange:[], repairedState:null};
    const kind = result.errorKind;
    const at = result.errorAt;
    const errorTarget = (result.errorTarget != null) ? result.errorTarget : -1;

    // CAS DOUBLON : si le glyph fautif duplique une case déjà remplie,
    // on le RETIRE temporairement, on revalide, et les glyphs suivants -> orange.
    const dupCell = findDuplicateCell(glyphs, result);
    if(dupCell >= 0){
      const repaired = glyphs.slice(0,at).concat(glyphs.slice(at+1));
      const rres = validate(repaired);
      const orange = [];
      const orangeOrigSrc = [];
      rres.st.forEach((s,i) => {
        const impactedHere = (isInteractive(CASES[i]) && s.filled) || (!isInteractive(CASES[i]) && s.typed);
        if(impactedHere && s.srcChar >= at){
          if(isInteractive(CASES[i]) && s.filled) orange.push(i);
          orangeOrigSrc.push(s.srcChar + 1); // un glyph retiré à 'at'
        }
      });
      return {orange, repairedState:rres.st, orangeOrigSrc};
    }

    let repairGlyph = null;
    let hideRepairedSub = -1;
    if(kind === 'need_subpart'){
      // réinsérer une subpart qui rend la séquence valide (1er candidat)
      for(const sg of Object.values(SUBPART_GLYPHS)){
        const test = glyphs.slice(0,at).concat([sg], glyphs.slice(at));
        if(validate(test).errorAt < 0){ repairGlyph = sg; break; }
      }
    } else if(kind === 'need_part'){
      // doigt MÉMORISÉ : retrouver où l'orphelin était posé avant la suppression de la part
      let memFinger = null;
      if(lastPlacement && lastPlacement.length){
        for(let oi=at; oi<glyphs.length; oi++){
          const og = glyphs[oi];
          const gk = glyphKind(og);
          if(oi>at && (gk==='part' || gk==='ponctuation')) break;
          const hit = lastPlacement.find(p => p.glyph === og);
          if(hit && hit.fingerName){ memFinger = hit.fingerName; break; }
        }
      }
      if(memFinger && PART_GLYPHS[memFinger]){
        const pg = PART_GLYPHS[memFinger];
        const test = glyphs.slice(0,at).concat([pg], glyphs.slice(at));
        if(validate(test).errorAt < 0){ repairGlyph = pg; }
      }
      if(repairGlyph == null){
        for(const pg of Object.values(PART_GLYPHS)){
          const test = glyphs.slice(0,at).concat([pg], glyphs.slice(at));
          if(validate(test).errorAt < 0){ repairGlyph = pg; break; }
        }
      }
    } else if(kind === 'need_subvar'){
      // value orpheline (subvar manquante) : réinsérer une subvar du même bloc
      // (celle de la case errorTarget) pour que la value se place, puis l'orange.
      // errorTarget = la case subvar vide. On prend une option non-undefined de SON groupe.
      const subCase = CASES[errorTarget];
      if(subCase && subCase.dataOptions){
        const opts = GROUPS[subCase.dataOptions] || [];
        const realOpt = opts.find(o => o.label !== 'undefined');
        if(realOpt){
          const test = glyphs.slice(0,at).concat([realOpt.glyph], glyphs.slice(at));
          const tr = validate(test);
          if(tr.errorAt < 0){ repairGlyph = realOpt.glyph; hideRepairedSub = errorTarget; }
        }
      }
    }

    if(repairGlyph == null) return {orange:[], repairedState:null};

    const repaired = glyphs.slice(0,at).concat([repairGlyph], glyphs.slice(at));
    const rres = validate(repaired);
    // need_subvar : ne PAS afficher la subvar réinsérée -> la case qui a reçu la subvar
    // réinsérée (srcChar === at) redevient undefined pour rester bleue.
    rres.st.forEach((s,i) => {
      if(isInteractive(CASES[i]) && CASES[i].kind==='sub variable' && s.filled && s.srcChar === at){
        s.filled = false; s.glyph = CASES[i].fixedGlyph;
      }
    });
    // L'orange se limite au BLOC VARIABLE de l'erreur (subvar + sa value), pas à toute
    // la subpart : un bloc autonome correct voisin ne prend pas l'orange.
    function blockEndOf(caseIdx){
      // fin du bloc variable contenant caseIdx : une subvar suivie de sa value.
      // On avance tant qu'on est dans le même bloc (sub variable -> value).
      let end = caseIdx;
      for(let k=caseIdx+1;k<CASES.length;k++){
        const kind = CASES[k].kind;
        // on s'arrête dès qu'on atteint une nouvelle sub variable, sub part, part ou ponctuation
        if(kind==='sub variable'||kind==='sub part'||kind==='part'||kind==='ponctuation') break;
        end = k; // value/variable du même bloc
      }
      return end;
    }
    const orangeLimit = blockEndOf(errorTarget >= 0 ? errorTarget : at);
    const orange = [];
    const orangeOrigSrc = [];
    rres.st.forEach((s,i) => {
      const impactedHere = (isInteractive(CASES[i]) && s.filled) || (!isInteractive(CASES[i]) && s.typed);
      // l'orange s'arrête à la fin de la subpart impliquée (i <= orangeLimit)
      if(impactedHere && s.srcChar >= at+1 && i <= orangeLimit){
        if(isInteractive(CASES[i]) && s.filled) orange.push(i);
        orangeOrigSrc.push(s.srcChar - 1);
      }
    });
    return {orange, repairedState:rres.st, orangeOrigSrc};
  }

  // ---------- DÉCOUPER la valeur de l'input en glyphs ----------
  const DOT = '◌'; // caractère "il manque un élément" (vrai char dans l'input)
  function toGlyphs(str){
    // la validation IGNORE les ◌ (ce ne sont pas de vrais glyphes)
    return Array.from(str).filter(ch => ch !== DOT);
  }

  // ---------- ÉVÉNEMENT PRINCIPAL : tout changement de l'input ----------
  const mirrorEl = document.getElementById('input-mirror');
/* =====================================================================
   MODÈLE (base de données cachée) — ÉTAPE 1
   ---------------------------------------------------------------------
   Le modèle est la liste ordonnée des recs. Un rec = un glyphe saisi.
   Structure d'un rec :
     { id, glyph, caseId }
       id     : numéro temporel d'intervention (code-barre), unique, repart
              à 1 à chaque clear. Ne se réutilise jamais dans une compo.
       glyph  : le caractère Unicode saisi (full, semi, ref pos…).
       caseId : le bloc visé (dataOptions de la case cliquée) si le glyphe
              vient de la FORMULE ; null si clavier.

   ÉTAPE 1 : le modèle est construit et maintenu EN PARALLÈLE, mais n'est
   utilisé par RIEN. Aucune modification de validate/render/syncMirror.
   But : vérifier qu'il reflète fidèlement l'état (comparaison au texte).
   ===================================================================== */

  // La liste des recs (le modèle).
  let MODEL = [];
  // Compteur d'id : prochain id à attribuer. Repart à 1 au clear.
  let MODEL_nextId = 1;

  // Ajouter un rec au modèle. Retourne le rec créé.
  // glyph  : le caractère saisi
  // caseId : dataOptions de la case cliquée (formule) ou null (clavier)
  // atIndex: position d'insertion dans la liste (défaut = fin). Permet de
  //          refléter un glyphe inséré au milieu (clic formule ordonné).
  function modelAdd(glyph, caseId, atIndex){
    const rec = { id: MODEL_nextId++, glyph: glyph, caseId: (caseId != null ? caseId : null) };
    if(atIndex == null || atIndex < 0 || atIndex >= MODEL.length){
      MODEL.push(rec);
    } else {
      MODEL.splice(atIndex, 0, rec);
    }
    return rec;
  }

  // Retirer le rec à une position donnée dans la liste.
  function modelRemoveAt(index){
    if(index >= 0 && index < MODEL.length){ return MODEL.splice(index, 1)[0]; }
    return null;
  }

  // Retirer le rec portant un id donné.
  function modelRemoveById(id){
    const i = MODEL.findIndex(r => r.id === id);
    return i >= 0 ? MODEL.splice(i, 1)[0] : null;
  }

  // Vider le modèle et réinitialiser le compteur d'id (appelé au clear).
  function modelClear(){
    MODEL = [];
    MODEL_nextId = 1;
  }

  // La séquence de glyphes du modèle, dans l'ordre de la liste (SANS les ◌,
  // qui ne sont pas des recs mais des manques). Sert à comparer au texte.
  function modelGlyphs(){
    return MODEL.map(r => r.glyph);
  }

  // Les caseIds du modèle, alignés sur modelGlyphs (MODEL[i].caseId pour glyphs[i]).
  // Sert à passer les caseIds à validate() dans les recalculs internes, pour que le
  // placement interne corresponde au placement du flux principal.
  function modelCaseIds(){
    return MODEL.map(r => r.caseId);
  }

  // --- DEBUG : représentation lisible du modèle, pour comparer au texte ---
  function modelDump(){
    return MODEL.map(r => {
      const src = r.caseId ? ('F:' + r.caseId) : 'K';
      return '#' + r.id + ' ' + r.glyph + ' [' + src + ']';
    }).join('  |  ');
  }

  // Compare la séquence de glyphes du modèle au texte du champ (hors ◌).
  // Retourne { ok, modelStr, fieldStr }. Sert de sonde de fidélité (étape 1).
  function modelCheckAgainstField(){
    const fieldGlyphs = Array.from(inputEl.value).filter(ch => ch !== DOT);
    const modelStr = modelGlyphs().join('');
    const fieldStr = fieldGlyphs.join('');
    return { ok: (modelStr === fieldStr), modelStr: modelStr, fieldStr: fieldStr };
  }

  // RÉCONCILIATION : aligner le MODÈLE sur les glyphes actuels du champ (hors ◌), en
  // PRÉSERVANT les recs existants qui correspondent encore (mêmes glyphes, même ordre), et
  // en ajoutant/retirant ce qui a changé. Sert pour les modifications CLAVIER (frappe, collage,
  // suppression au milieu), où l'on ne peut pas capter finement chaque opération : on compare
  // l'état final et on corrige. Les nouveaux glyphes reçoivent caseId null (origine clavier).
  // Algorithme : diff par plus longue sous-séquence commune simplifiée (glouton par glyphe).
  function modelReconcileWithField(){
    const field = Array.from(inputEl.value).filter(ch => ch !== DOT);
    // Si déjà aligné, ne rien faire (cas normal : les clics formule maintiennent le modèle).
    let same = (field.length === MODEL.length);
    if(same){ for(let i=0;i<field.length;i++){ if(MODEL[i].glyph !== field[i]){ same=false; break; } } }
    if(same) return;
    // Diff glouton : parcourir field et MODEL en parallèle, réutiliser les recs dont le glyphe
    // correspond, insérer un nouveau rec (caseId null) pour un glyphe ajouté, sauter (retirer)
    // un rec dont le glyphe ne correspond plus.
    const newModel = [];
    let mi = 0; // index dans l'ancien MODEL
    for(let fi = 0; fi < field.length; fi++){
      const g = field[fi];
      if(mi < MODEL.length && MODEL[mi].glyph === g){
        // rec existant conservé (préserve id + caseId)
        newModel.push(MODEL[mi]); mi++;
      } else {
        // chercher plus loin dans MODEL un rec au même glyphe (cas suppression d'un rec avant)
        let found = -1;
        for(let k = mi+1; k < MODEL.length; k++){ if(MODEL[k].glyph === g){ found = k; break; } }
        if(found >= 0){
          // les recs entre mi et found ont été supprimés du champ : on les saute
          mi = found;
          newModel.push(MODEL[mi]); mi++;
        } else {
          // glyphe nouveau (frappe clavier) : créer un rec caseId null
          newModel.push({ id: MODEL_nextId++, glyph: g, caseId: null });
        }
      }
    }
    // remplacer le contenu de MODEL par newModel (en place, pour préserver la référence)
    MODEL.length = 0;
    for(const r of newModel){ MODEL.push(r); }
  }


  // Synchronise la div miroir avec le contenu de l'input (E1 : texte brut)
  function syncMirror(result, glyphs){
    const inner = document.createElement('span');
    inner.className = 'mirror-inner';

    // La miroir affiche la valeur RÉELLE de l'input (qui contient le ◌ si trou).
    const raw = Array.from(inputEl.value);

    // Index du caractère fautif (faute : doublon, no_match, bad_value) à colorer rouge.
    // result.errorAt est dans la séquence FILTRÉE (sans ◌). On le convertit en index raw.
    // toutes les positions fautives (fautes = no_match, bad_value, doublon)
    const wrongRawSet = new Set();
    const errList = result.errors || (result.errorAt >= 0 ? [{at:result.errorAt, kind:result.errorKind}] : []);
    errList.forEach(e => {
      const isFault = (e.kind === 'no_match' || e.kind === 'bad_value');
      // doublon : vérifier via findDuplicateCell sur un subResult
      let isDup = false;
      if(!isFault){
        const sub = {st:result.st, errorAt:e.at, errorKind:e.kind, _glyphs:glyphs};
        isDup = findDuplicateCell(glyphs, sub) >= 0;
      }
      if(isFault || isDup){
        // convertir e.at (filtré) en index raw
        let count = 0;
        for(let i=0;i<raw.length;i++){
          if(raw[i] === DOT) continue;
          if(count === e.at){ wrongRawSet.add(i); break; }
          count++;
        }
      }
    });

    // positions (raw) à colorer en ORANGE : convertir les srcChar filtrés en index raw
    const orangeRaw = new Set();
    const orangeSrcList = result._orangeSrcChars || [];
    if(orangeSrcList.length){
      let cnt = 0;
      for(let i=0;i<raw.length;i++){
        if(raw[i] === DOT) continue;
        if(orangeSrcList.includes(cnt)) orangeRaw.add(i);
        cnt++;
      }
    }
    raw.forEach((ch, i) => {
      const sp = document.createElement('span');
      sp.textContent = ch;
      sp.setAttribute('data-rawidx', i);
      if(ch === DOT){
        sp.className = 'ins-caret';        // le ◌ en rouge
      } else if(wrongRawSet.has(i)){
        sp.className = 'ch-wrong';          // faute en rouge
      } else if(orangeRaw.has(i)){
        sp.className = 'ch-impact';         // impacté en orange
      }
      inner.appendChild(sp);
    });

    mirrorEl.innerHTML = '';
    mirrorEl.appendChild(inner);
    mirrorEl.scrollLeft = inputEl.scrollLeft;
  }

  let isSyncing = false; // anti-récursion lors de la manipulation de l'input

  // Mémoire : dernier placement connu des glyphes interactifs.
  // Map: signature du glyphe orphelin -> nom du doigt où il était placé.
  // On stocke, pour le dernier état VALIDE, la liste {glyph, fingerName, caseIdx}.
  let lastPlacement = []; // [{srcChar, caseIdx, fingerName, glyph}]
  function rememberPlacement(result){
    if(result.errorAt >= 0) return; // ne mémoriser que les états valides
    const snap = [];
    result.st.forEach((s,i) => {
      if(isInteractive(CASES[i]) && s.filled){
        // trouver le doigt (part) de cette case
        let fn = null;
        for(let k=i;k>=0;k--){ if(CASES[k].kind==='part'){ fn=partNameOf(k); break; } }
        snap.push({srcChar:s.srcChar, caseIdx:i, fingerName:fn, glyph:s.glyph});
      }
    });
    lastPlacement = snap;
  }

  let lastResult = null;        // dernier résultat de validate (pour hover/clavier)
  let lastHoleInfos = [];       // [{rawPos, kind, target}] : chaque ◌ et ce qui le résout
  let prevHoleCount = 0;        // nb de ◌ au rendu précédent (pour détecter une création)
  let prevHoleTargets = [];     // cases cibles des ◌ au rendu précédent
  let lastCreatedHoleTarget = -1; // case cible du DERNIER ◌ créé temporellement (focus par défaut)
  function onInputChanged(reason){
    if(isSyncing) return; // ignore les events déclenchés par notre propre manipulation
    if(typeof modelClear === 'function' && (reason === 'clear' || reason === 'init')){ modelClear(); }
    // CLAVIER : réconcilier le modèle avec le champ (frappe, collage, suppression au milieu).
    // Les clics formule maintiennent déjà le modèle ; ici on rattrape les éditions manuelles.
    if(typeof modelReconcileWithField === 'function' && (reason === 'edit' || reason === 'clic')){ modelReconcileWithField(); }

    // 1. Retirer tous les ◌ existants pour repartir d'une base propre,
    //    en mémorisant la position du curseur ajustée.
    const rawBefore = Array.from(inputEl.value);
    let caret = inputEl.selectionStart;
    if(caret == null) caret = rawBefore.length;
    // compter les ◌ avant le curseur pour réajuster
    let dotsBeforeCaret = 0;
    for(let i=0;i<caret && i<rawBefore.length;i++){ if(rawBefore[i]===DOT) dotsBeforeCaret++; }
    const cleanValue = rawBefore.filter(ch => ch !== DOT).join('');
    const cleanCaret = caret - dotsBeforeCaret;

    // 2. Valider la séquence pure
    const glyphs = Array.from(cleanValue);
    const result = validate(glyphs, (typeof modelCaseIds==='function'?modelCaseIds():[]));
    result._glyphs = glyphs;

    // 3. Déterminer TOUTES les positions de trou (une par erreur structurelle "manque").
    const holePositions = [];
    const allErrs = result.errors || (result.errorAt >= 0 ? [{at:result.errorAt, kind:result.errorKind}] : []);
    allErrs.forEach(e => {
      const isHole = ['need_part','need_subpart','need_subvar','value_due'].includes(e.kind);
      if(isHole) holePositions.push(e.at);
    });

    // 4. Insérer un ◌ à CHAQUE position de trou. On insère de DROITE à GAUCHE
    //    (positions décroissantes) pour ne pas décaler les positions suivantes.
    let newValue = cleanValue;
    let newCaret = cleanCaret;
    if(holePositions.length){
      const cleanArr = Array.from(cleanValue);
      const sorted = holePositions.slice().sort((a,b)=>b-a); // décroissant
      sorted.forEach(pos => {
        cleanArr.splice(pos, 0, DOT);
        if(cleanCaret >= pos) newCaret++;
      });
      newValue = cleanArr.join('');
    }

    // Construire lastHoleInfos : pour chaque ◌ (dans newValue), le type de manque + la case cible.
    // Les holePositions sont en index FILTRÉ ; on les relie aux erreurs correspondantes.
    lastResult = result;
    lastHoleInfos = [];
    {
      // map : position filtrée du ◌ -> erreur (kind, target)
      const holeErrs = (result.errors||[]).filter(e => ['need_part','need_subpart','need_subvar','value_due'].includes(e.kind));
      // recalculer les positions RAW des ◌ dans newValue
      const rawArr = Array.from(newValue);
      let filteredIdx = 0, hi = 0;
      const sortedHoles = holePositions.slice().sort((a,b)=>a-b); // croissant
      for(let i=0;i<rawArr.length;i++){
        if(rawArr[i] === DOT){
          // ce ◌ correspond au hole sortedHoles[hi]
          const fpos = sortedHoles[hi];
          const err = holeErrs.find(e => e.at === fpos);
          lastHoleInfos.push({rawPos:i, kind: err?err.kind:null, target: err?err.target:-1});
          hi++;
        } else {
          filteredIdx++;
        }
      }
    }
    // Détecter le ◌ NOUVELLEMENT apparu (le dernier créé temporellement) = focus par défaut.
    const curTargets = lastHoleInfos.map(h => h.target);
    const newTargets = curTargets.filter(t => prevHoleTargets.indexOf(t) < 0);
    if(newTargets.length){
      // un nouveau ◌ est apparu -> il devient le dernier créé
      lastCreatedHoleTarget = newTargets[newTargets.length - 1];
    } else if(curTargets.indexOf(lastCreatedHoleTarget) < 0){
      // le ◌ le plus récent a été résolu et rien de nouveau -> viser le ◌ le plus RÉCENT
      // restant (dernier de la liste), pour continuer à remonter le fil temporel.
      lastCreatedHoleTarget = curTargets.length ? curTargets[curTargets.length - 1] : -1;
    }
    prevHoleTargets = curTargets.slice();

    // Placement AUTO du curseur selon l'évolution du nombre de ◌ :
    //  - si un ◌ vient d'APPARAÎTRE (création) -> curseur sur le DERNIER ◌ (le plus récent)
    //  - si un ◌ vient d'être RÉSOLU (diminution) et qu'il en reste -> curseur sur le
    //    ◌ le plus à GAUCHE restant (on remonte le fil de l'écriture)
    const holeCount = lastHoleInfos.length;
    const isInsertion = (reason === 'clic' || reason === 'clic-formule' || reason === 'edit' || reason === 'resolution');
    // RÈGLE DE POSITIONNEMENT DU CURSEUR (unique) :
    //  - s'il reste des ◌ (need glyph) -> curseur sur le ◌ le plus RÉCEMMENT placé
    //    (on remonte le fil temporel de l'écriture, via lastCreatedHoleTarget) ;
    //  - s'il n'y a plus AUCUN ◌ -> curseur en FIN de champ (pour continuer à coder).
    if(isInsertion){
      if(holeCount > 0){
        // viser le ◌ le plus récemment placé ; à défaut, le dernier de la liste.
        const h = lastHoleInfos.find(x => x.target === lastCreatedHoleTarget);
        newCaret = h ? h.rawPos : lastHoleInfos[lastHoleInfos.length - 1].rawPos;
      } else if(prevHoleCount > 0){
        // le dernier ◌ vient d'être résolu -> fin de champ.
        newCaret = Array.from(newValue).length;
      }
    }
    prevHoleCount = holeCount;

    // 5. Appliquer à l'input SANS redéclencher la récursion
    if(newValue !== inputEl.value){
      isSyncing = true;
      inputEl.value = newValue;
      inputEl.setSelectionRange(newCaret, newCaret);
      isSyncing = false;
    } else {
      isSyncing = true;
      inputEl.setSelectionRange(newCaret, newCaret);
      isSyncing = false;
    }

    // 6. Rendu formule + miroir (la miroir affiche la valeur AVEC ◌, en couleur)
    render(result);
    syncMirror(result, glyphs);
    if(typeof refreshResolutionHighlight === 'function') refreshResolutionHighlight();
    if(typeof placeBlinkCaret === 'function') placeBlinkCaret();
    if(typeof pushHistory === 'function' && reason !== 'init' && reason !== 'undo-redo'){
      pushHistory();
    }
    // GARDE-FOU (dev) : le modèle doit rester fidèle au champ. Toute divergence signale
    // un chemin qui a modifié le texte sans mettre à jour le modèle (bug de migration).
    if(typeof modelCheckAgainstField === 'function' && reason !== 'init'){
      const _fid = modelCheckAgainstField();
      if(!_fid.ok){
        console.warn('[MODÈLE désynchronisé] reason=' + reason +
          ' | modèle(' + _fid.modelStr.length + ') != champ(' + _fid.fieldStr.length + ')');
      }
    }

    if(result.errorAt >= 0){
      const km = {need_part:'il manque la part', need_subpart:'il manque la sub part',
                  need_subvar:'il manque la sub variable', value_due:'value due dans ce bloc',
                  bad_value:'valeur non permise', no_match:'glyph hors séquence'};
      log("["+reason+"] ✗ "+(km[result.errorKind]||result.errorKind)+" au glyph #"+result.errorAt);
    } else {
      log("["+reason+"] ✓ séquence cohérente ("+glyphs.length+" glyphs)");
    }
  }

  // frappe clavier : insère le glyph à la position du curseur (ou à la fin)
  // ---- F4 : insérer un glyphe à sa position ORDONNÉE selon l'index de sa case ----
  // Chaque caractère du champ correspond à une case (via srcChar). Le glyphe cliqué
  // a l'index de SA case. On l'insère pour respecter l'ordre croissant des index.
  function caseIdxOfChar(){
    // retourne un tableau : pour chaque position filtrée du champ, l'index de case
    const glyphs = toGlyphs(inputEl.value);
    const result = validate(glyphs, (typeof modelCaseIds==='function'?modelCaseIds():[]));
    const posToCase = new Array(glyphs.length).fill(999); // 999 = inconnu -> à la fin
    result.st.forEach((s,i) => {
      if((s.filled || s.typed) && s.srcChar >= 0 && s.srcChar < glyphs.length){
        // une case peut couvrir plusieurs positions (cascade) ; on garde l'index de case
        if(posToCase[s.srcChar] === 999) posToCase[s.srcChar] = i;
        else posToCase[s.srcChar] = Math.min(posToCase[s.srcChar], i);
      }
    });
    return {glyphs, posToCase};
  }
  // Remonter depuis une case : la 1re case 'part' au-dessus, la 1re 'sub part' au-dessus
  function partCellAbove(caseIdx){
    // une part n'a pas d'ancre part au-dessus (elle EST le sommet du segment)
    if(CASES[caseIdx].kind === 'part') return -1;
    for(let i=caseIdx;i>=0;i--){ if(CASES[i].kind==='part') return i; }
    return -1;
  }
  function subpartCellAbove(caseIdx){
    // remonter jusqu'à la sub part du MÊME segment. Si on croise une part avant
    // (ou si la case cliquée est elle-même une part/sub part), pas de sub part parente.
    if(CASES[caseIdx].kind === 'part') return -1; // une part n'a pas de subpart parente
    for(let i=caseIdx;i>=0;i--){
      if(CASES[i].kind==='sub part') return (i===caseIdx ? -1 : i); // la case elle-même n'est pas son ancre
      if(CASES[i].kind==='part') return -1; // on a atteint la part sans trouver de subpart avant
    }
    return -1;
  }
  // Un glyphe (à une position ordonnée) est-il DÉJÀ présent dans le champ sur la bonne case ?
  function caseAlreadyFilled(caseIdx){
    const glyphs = toGlyphs(inputEl.value);
    const result = validate(glyphs, (typeof modelCaseIds==='function'?modelCaseIds():[]));
    const s = result.st[caseIdx];
    return s && (s.filled || s.typed);
  }
  // Retire les ancres (part + sub part) d'un segment si plus AUCUN glyphe interactif
  // n'y est rempli. On ne retire une ancre que si aucun autre glyphe ne l'utilise.
  function cleanupOrphanAnchors(refCaseIdx){
    // localiser la part et la sub part au-dessus de refCaseIdx
    let partIdx=-1, subpartIdx=-1;
    for(let i=refCaseIdx;i>=0;i--){
      if(CASES[i].kind==='sub part'&&subpartIdx<0)subpartIdx=i;
      if(CASES[i].kind==='part'){partIdx=i;break;}
    }
    function segmentHasContent(startIdx, stopKinds){
      // y a-t-il un glyphe interactif rempli entre startIdx+1 et la prochaine frontière ?
      const _g = toGlyphs(inputEl.value);
      const _r = validate(_g, (typeof modelCaseIds==='function'?modelCaseIds():[]));
      for(let k=startIdx+1;k<CASES.length;k++){
        const ck=CASES[k].kind;
        if(stopKinds.indexOf(ck)>=0)break;
        if(isInteractive(CASES[k]) && _r.st[k].filled) return true;
      }
      return false;
    }
    function removeAnchorGlyph(anchorIdx){
      // retirer le glyphe fixe de l'ancre (part/subpart) du champ + modèle
      const anchorGlyph = CASES[anchorIdx].fixedGlyph;
      if(!anchorGlyph) return;
      const _g = toGlyphs(inputEl.value);
      const _r = validate(_g, (typeof modelCaseIds==='function'?modelCaseIds():[]));
      const s = _r.st[anchorIdx];
      if(!s || !s.typed || s.srcChar<0) return;
      const raw = Array.from(inputEl.value);
      let cnt=0, rp=-1;
      for(let i=0;i<raw.length;i++){ if(raw[i]===DOT)continue; if(cnt===s.srcChar){rp=i;break;} cnt++; }
      if(rp<0) return;
      raw.splice(rp,1); inputEl.value=raw.join('');
      if(typeof modelRemoveAt==='function'){ modelRemoveAt(s.srcChar); }
    }
    // 1) la sub part : plus de contenu dans CE segment de subpart -> retirer la subpart
    if(subpartIdx>=0 && !segmentHasContent(subpartIdx, ['sub part','part','ponctuation'])){
      removeAnchorGlyph(subpartIdx);
      // 2) la part : plus AUCUN contenu dans tout le doigt -> retirer la part
      if(partIdx>=0 && !segmentHasContent(partIdx, ['part','ponctuation'])){
        removeAnchorGlyph(partIdx);
      }
    }
  }

  // Retirer le glyphe occupant une case (clic 'undefined' = vider le bloc).
  // Retire le rec correspondant du champ + du modèle, puis recalcule.
  function removeGlyphFromCase(clickedCaseIdx){
    if(clickedCaseIdx == null || clickedCaseIdx < 0 || !CASES[clickedCaseIdx]) return;
    const _g = toGlyphs(inputEl.value);
    const _r = validate(_g, (typeof modelCaseIds==='function'?modelCaseIds():[]));
    const s = _r.st[clickedCaseIdx];
    if(!s || !(s.filled || s.typed) || s.srcChar < 0) return;
    // trouver la position RAW du caractère à retirer
    const raw = Array.from(inputEl.value);
    let cnt = 0, rawPos = -1;
    for(let i=0;i<raw.length;i++){
      if(raw[i] === DOT) continue;
      if(cnt === s.srcChar){ rawPos = i; break; }
      cnt++;
    }
    if(rawPos < 0) return;
    raw.splice(rawPos, 1);
    inputEl.value = raw.join('');
    if(typeof modelRemoveAt === 'function'){ modelRemoveAt(s.srcChar); }
    // NETTOYAGE ANCRES : après ce retrait, si le segment (doigt/phalange) n'a plus
    // aucun glyphe interactif rempli, retirer les ancres part+subpart devenues inutiles.
    cleanupOrphanAnchors(clickedCaseIdx);
    // Cas couple : si on retire une subvar ref pos, le zero lié (virtuel) part seul.
    // Si on retire une value dont la subvar était un ref pos, retirer aussi le ref pos
    // (le couple ref pos+zero est full linked : vider l'un vide l'autre).
    if(CASES[clickedCaseIdx].kind === 'value'){
      const subCase = clickedCaseIdx - 1;
      if(CASES[subCase] && CASES[subCase].kind === 'sub variable'){
        const _g2 = toGlyphs(inputEl.value);
        const _r2 = validate(_g2, (typeof modelCaseIds==='function'?modelCaseIds():[]));
        const ss = _r2.st[subCase];
        if(ss && (ss.filled||ss.typed) && ss.glyph === G_REFPOS && ss.srcChar >= 0){
          const raw2 = Array.from(inputEl.value);
          let c2=0, rp2=-1;
          for(let i=0;i<raw2.length;i++){ if(raw2[i]===DOT)continue; if(c2===ss.srcChar){rp2=i;break;} c2++; }
          if(rp2>=0){ raw2.splice(rp2,1); inputEl.value=raw2.join('');
            if(typeof modelRemoveAt==='function'){ modelRemoveAt(ss.srcChar); } }
        }
      }
    }
    onInputChanged('clic-formule');
  }
  // Injecte, à leur position ordonnée, les ancres (part+subpart) manquantes puis le glyphe.
  function insertGlyphOrdered(glyph, clickedCaseIdx){
    // garde : ignorer un index de case invalide (case inexistante)
    if(clickedCaseIdx == null || clickedCaseIdx < 0 || !CASES[clickedCaseIdx]) return;
    // RÈGLE B : clic d'une VALUE non-zero sur un bloc dont la subvar est un REF POS (couple).
    // ref pos et zero sont full linked : remplacer le zero (value du couple) par une autre value
    // fait DISPARAÎTRE le ref pos (il devient un ◌ need_subvar), et la value cliquée se pose.
    if(CASES[clickedCaseIdx] && CASES[clickedCaseIdx].kind === 'value' && glyph !== G_ZERO && glyph !== G_REFPOS){
      const subCase = clickedCaseIdx - 1;
      if(CASES[subCase] && CASES[subCase].kind === 'sub variable'){
        const _cg0 = toGlyphs(inputEl.value);
        const _cr0 = validate(_cg0, (typeof modelCaseIds==='function'?modelCaseIds():[]));
        const subSt = _cr0.st[subCase];
        // la subvar du bloc cliqué est-elle un ref pos rempli ?
        if(subSt && (subSt.filled || subSt.typed) && subSt.glyph === G_REFPOS && subSt.srcChar >= 0){
          // retirer le REC du ref pos (position filtrée = subSt.srcChar). Le zero lié étant
          // virtuel (pas un rec), il disparaît de lui-même quand le ref pos n'est plus là.
          const raw = Array.from(inputEl.value);
          let cnt = 0, rawPos = -1;
          for(let i=0;i<raw.length;i++){
            if(raw[i] === DOT) continue;
            if(cnt === subSt.srcChar){ rawPos = i; break; }
            cnt++;
          }
          if(rawPos >= 0){
            raw.splice(rawPos, 1);
            inputEl.value = raw.join('');
            if(typeof modelRemoveAt === 'function'){ modelRemoveAt(subSt.srcChar); }
          }
          // poser la value cliquée : elle ira dans sa case (le validateur générera un ◌ pour la
          // subvar manquante). On passe par la logique normale d'insertion ci-dessous.
        }
      }
    }
    // CAS REMPLACEMENT : clic sur une VALUE ou une SUBVAR dont le bloc a DÉJÀ un glyphe
    // du même type dans le champ -> remplacer l'existant.
    if(CASES[clickedCaseIdx] && (CASES[clickedCaseIdx].kind === 'value' || CASES[clickedCaseIdx].kind === 'sub variable')){
      // valider sur l'état ACTUEL du champ (lastResult peut être périmé)
      const _cg = toGlyphs(inputEl.value);
      const _cr = validate(_cg, (typeof modelCaseIds==='function'?modelCaseIds():[]));
      const existing = _cr.st[clickedCaseIdx];
      // Vérifier via le MODÈLE que le glyphe occupant appartient VRAIMENT au bloc cliqué.
      // Le rec correspondant est celui à la position filtrée existing.srcChar.
      let existingBelongsHere = true;
      if(existing && existing.srcChar >= 0 && typeof MODEL !== 'undefined' && MODEL[existing.srcChar]){
        const recCaseId = MODEL[existing.srcChar].caseId;
        const clickedCaseId = CASES[clickedCaseIdx] ? CASES[clickedCaseIdx].dataOptions : null;
        // si le rec a un caseId explicite (vient de la formule) ET qu'il ne correspond PAS au
        // bloc cliqué -> ce glyphe n'appartient pas à ce bloc, ce n'est pas un remplacement.
        if(recCaseId != null && clickedCaseId != null && recCaseId !== clickedCaseId){
          existingBelongsHere = false;
        }
      }
      if(existingBelongsHere && existing && (existing.filled || existing.orphan) && existing.srcChar >= 0){
        // trouver la position RAW du caractère existant
        const raw = Array.from(inputEl.value);
        let cnt = 0, rawPos = -1;
        for(let i=0;i<raw.length;i++){
          if(raw[i] === DOT) continue;
          if(cnt === existing.srcChar){ rawPos = i; break; }
          cnt++;
        }
        if(rawPos >= 0){
          if(glyph === G_REFPOS || glyph === G_ZERO){
            // ref pos et zero sont FULL LINKÉS : cliquer l'un ou l'autre pose TOUJOURS le couple
            // (ref pos + zero), quel que soit le contenu du bloc. Ne rien retirer ici : la logique
            // du couple (plus bas) recalcule sur l'état actuel et retire elle-même la value ET la
            // subvar existantes. (Retirer ici causait un double retrait / conflit avec le ◌.)
          } else {
            // remplacement simple (value->value, ou subvar->subvar non-refpos)
            raw[rawPos] = glyph;
            inputEl.value = raw.join('');
            // ===== MODÈLE : le rec à cette position filtrée change de glyphe + caseId =====
            if(typeof MODEL !== 'undefined' && MODEL[existing.srcChar]){
              MODEL[existing.srcChar].glyph = glyph;
              const cid = (CASES[clickedCaseIdx] && CASES[clickedCaseIdx].dataOptions) ? CASES[clickedCaseIdx].dataOptions : null;
              MODEL[existing.srcChar].caseId = cid;
            }
            onInputChanged('clic-formule');
            return;
          }
        }
      }
    }
    // CAS SPÉCIAL RÉSOLUTION : on clique une SUBVAR pour combler un ◌.
    // Si une value orpheline du bloc de cette subvar existe (◌ en attente juste avant),
    // insérer la subvar À LA POSITION DU ◌ (juste avant la value orpheline).
    if(CASES[clickedCaseIdx] && CASES[clickedCaseIdx].kind === 'sub variable' && glyph !== G_REFPOS && glyph !== G_ZERO){
      const raw0 = Array.from(inputEl.value);
      // trouver l'index RAW du premier ◌ dont la value orpheline suivante est du bloc cliqué.
      // On repère les ◌ et on vérifie que la value juste après (dans la séquence filtrée)
      // correspond au bloc de la subvar cliquée.
      // segment (part+subpart) de la subvar cliquée
      function segmentOf(caseIdx){
        // bloc = part + subpart + VARIABLE (distingue flxext / abdadd / rinrex)
        let p=-1,s=-1,v=-1;
        for(let i=caseIdx;i>=0;i--){
          if(CASES[i].kind==='variable'&&v<0){ v=i; }
          if(CASES[i].kind==='sub part'&&s<0){ s=i; }
          if(CASES[i].kind==='part'){ p=i; break; }
        }
        return p+'_'+s+'_'+v;
      }
      const clickedSeg = segmentOf(clickedCaseIdx);
      // Utiliser lastHoleInfos (fiable) : trouver le ◌ dont le TARGET est la subvar cliquée,
      // ou dont le target est dans le MÊME segment (part+subpart) que la subvar cliquée.
      let targetDotRaw = -1;
      if(lastHoleInfos && lastHoleInfos.length){
        // priorité 1 : un ◌ dont le target EST exactement la subvar cliquée
        for(const h of lastHoleInfos){
          if(h.target === clickedCaseIdx){ targetDotRaw = h.rawPos; break; }
        }
        // priorité 2 : un ◌ dont le target est dans le même segment (need_subvar du bloc)
        if(targetDotRaw < 0){
          for(const h of lastHoleInfos){
            if(h.target >= 0 && segmentOf(h.target) === clickedSeg && h.kind === 'need_subvar'){
              targetDotRaw = h.rawPos; break;
            }
          }
        }
      }
      if(targetDotRaw >= 0){
        raw0.splice(targetDotRaw, 1, glyph);
        inputEl.value = raw0.join('');
        // ===== MODÈLE : ajouter un rec pour la subvar (le ◌ remplacé n'était pas un rec) =====
        if(typeof modelAdd === 'function'){
          let modelPos = 0;
          for(let q=0; q<targetDotRaw; q++){ if(raw0[q] !== DOT) modelPos++; }
          const cid = (CASES[clickedCaseIdx] && CASES[clickedCaseIdx].dataOptions) ? CASES[clickedCaseIdx].dataOptions : null;
          modelAdd(glyph, cid, modelPos);
        }
        onInputChanged('resolution');
        return;
      }
    }
    // 1. Déterminer les ancres nécessaires : TOUTE la chaîne d'ancres de la case cliquée
    //    (part, selection, sub part, subselection selon la page). Généralise part+subpart.
    const toInsert = []; // liste de {glyph, caseIdx}
    const fieldGlyphs = toGlyphs(inputEl.value);
    const chain = CASES[clickedCaseIdx] ? CASES[clickedCaseIdx].anchorChain : [];
    chain.forEach(a => {
      const ag = a.glyph || (CASES[a.caseIdx] ? CASES[a.caseIdx].fixedGlyph : null);
      if(!ag) return;
      if(a.level === 1){
        // PART : n'injecter que si son glyphe n'est pas déjà présent (couvre tous ses segments)
        if(!fieldGlyphs.includes(ag)) toInsert.push({glyph: ag, caseIdx: a.caseIdx});
      } else {
        // selection / sub part / subselection : propres à un segment précis.
        // n'injecter que si cette case d'ancre n'est pas déjà remplie dans le champ.
        if(!caseAlreadyFilled(a.caseIdx)) toInsert.push({glyph: ag, caseIdx: a.caseIdx});
      }
    });
    // ref pos / zero cliqué dans la formule : remplir le bloc SANS cascade.
    // On injecte : la variable du bloc (casse la cascade) + ref pos sur la subvar
    // + zero sur la value (le linkage de paire, appliqué explicitement au seul bloc).
    // Vérifier si le bloc cliqué a DÉJÀ une subvar remplie : dans ce cas, le zero/ref pos
    // ne pose PAS le couple lié (variable + ref pos) ; il devient simplement la value/subvar
    // du bloc existant (traité comme un glyphe normal plus bas).
    // ref pos et zero sont FULL LINKÉS : cliquer l'un ou l'autre pose TOUJOURS le couple.
    if((glyph === G_REFPOS || glyph === G_ZERO)){
      // trouver la subvar et la value du bloc cliqué
      let subvarCase = -1, valueCase = -1, varCase = -1;
      // le bloc = subvar (kind sub variable) + value (kind value) contigües autour du clic
      if(CASES[clickedCaseIdx].kind === 'sub variable'){ subvarCase = clickedCaseIdx; valueCase = clickedCaseIdx + 1; }
      else if(CASES[clickedCaseIdx].kind === 'value'){ valueCase = clickedCaseIdx; subvarCase = clickedCaseIdx - 1; }
      // la variable fixe juste avant la subvar
      for(let i = (subvarCase>=0?subvarCase:clickedCaseIdx); i >= 0; i--){
        if(CASES[i].kind === 'variable'){ varCase = i; break; }
        if(CASES[i].kind === 'sub part' || CASES[i].kind === 'part'){ break; }
      }
      if(varCase >= 0 && CASES[varCase].fixedGlyph && !caseAlreadyFilled(varCase)){
        toInsert.push({glyph: CASES[varCase].fixedGlyph, caseIdx: varCase});
      }
      // Retirer la VALUE existante du bloc : ref pos + zero prennent la main (option A).
      // ROBUSTE : le validateur peut avoir placé la value (ex: full ambigu) dans un AUTRE
      // bloc value du même segment (part+subpart). On cherche donc la value orpheline/remplie
      // du même segment que le bloc cliqué, où qu'elle soit dans st.
      if(valueCase >= 0){
        // segment (part+subpart) du bloc cliqué
        function segOfCase(ci){
          // bloc = part + subpart + VARIABLE (distingue flxext / abdadd / rinrex)
          let p=-1,s=-1,v=-1;
          for(let i=ci;i>=0;i--){
            if(CASES[i].kind==='variable'&&v<0){ v=i; }
            if(CASES[i].kind==='sub part'&&s<0){ s=i; }
            if(CASES[i].kind==='part'){ p=i; break; }
          }
          return p+'_'+s+'_'+v;
        }
        const targetSeg = segOfCase(valueCase);
        // part+subpart (SANS variable) pour repérer un full ambigu débordé sur un autre bloc
        function partSubOf(ci){
          let p=-1,s=-1;
          for(let i=ci;i>=0;i--){ if(CASES[i].kind==='sub part'&&s<0){s=i;} if(CASES[i].kind==='part'){p=i;break;} }
          return p+'_'+s;
        }
        const targetPartSub = partSubOf(valueCase);
        const curG = toGlyphs(inputEl.value);
        const curR = validate(curG, (typeof modelCaseIds==='function'?modelCaseIds():[]));
        let victimSrcChar = -1;
        // Retirer UNIQUEMENT la value du BLOC cliqué (même variable). Depuis que le validateur
        // place via les recs (caseId), il n'y a plus de "full ambigu débordé" à rattraper dans
        // un autre bloc : chaque value est déjà dans son bloc. On ne touche donc jamais un autre bloc.
        const exSelf = curR.st[valueCase];
        if(exSelf && (exSelf.filled || exSelf.orphan) && exSelf.srcChar >= 0){
          victimSrcChar = exSelf.srcChar;
        }
        if(victimSrcChar >= 0){
          const raw = Array.from(inputEl.value);
          let cnt = 0, rawPos = -1;
          for(let i=0;i<raw.length;i++){
            if(raw[i] === DOT) continue;
            if(cnt === victimSrcChar){ rawPos = i; break; }
            cnt++;
          }
          if(rawPos >= 0){
            raw.splice(rawPos, 1);
            inputEl.value = raw.join('');
            // ===== MODÈLE : retirer le rec à cette position filtrée =====
            if(typeof modelRemoveAt === 'function'){ modelRemoveAt(victimSrcChar); }
          }
        }
      }
      // Retirer la SUBVAR existante non-refpos (ex: ext rotation, flex) : le ref pos la remplace.
      // Recalcul sur l'état ACTUEL du champ.
      if(subvarCase >= 0){
        const curG2 = toGlyphs(inputEl.value);
        const curR2 = validate(curG2, (typeof modelCaseIds==='function'?modelCaseIds():[]));
        const exS = curR2.st[subvarCase];
        if(exS && (exS.filled || exS.typed) && exS.glyph !== G_REFPOS && exS.srcChar >= 0){
          const raw2 = Array.from(inputEl.value);
          let cnt2 = 0, rawPos2 = -1;
          for(let i=0;i<raw2.length;i++){
            if(raw2[i] === DOT) continue;
            if(cnt2 === exS.srcChar){ rawPos2 = i; break; }
            cnt2++;
          }
          if(rawPos2 >= 0){ raw2.splice(rawPos2, 1); inputEl.value = raw2.join('');
            if(typeof modelRemoveAt === 'function'){ modelRemoveAt(exS.srcChar); } }
        }
      }
      // ref pos et zero sont LIÉS at all times. Cliquer l'un ou l'autre pose le REF POS
      // sur la subvar ; le validateur génère le zero lié via le linkage de paire.
      if(subvarCase >= 0 && CASES[subvarCase] && CASES[subvarCase].kind === 'sub variable'){
        toInsert.push({glyph: G_REFPOS, caseIdx: subvarCase});
      }
    } else {
      // le glyphe cliqué lui-même (cas normal)
      toInsert.push({glyph: glyph, caseIdx: clickedCaseIdx});
    }

    // 2. Insérer chaque élément à sa position ordonnée, en calculant les positions sur l'état
    //    INITIAL stable (recalculer à chaque insertion casse quand une value crée un ◌
    //    au milieu du champ, ce qui rend les états intermédiaires instables).
    if(toInsert.length){
      // trier les insertions par ordre de case (part < subpart < variable < subvar < value)
      toInsert.sort((a,b) => a.caseIdx - b.caseIdx);
      // calculer, sur l'état initial, la position RAW d'insertion de chaque élément
      const {glyphs, posToCase} = caseIdxOfChar();
      // positions RAW des caractères non-◌ dans le champ actuel
      const raw = Array.from(inputEl.value);
      const rawPosOfFiltered = []; // filtered idx -> raw idx
      for(let i=0;i<raw.length;i++){ if(raw[i] !== DOT) rawPosOfFiltered.push(i); }
      // pour chaque élément à insérer, trouver sa position filtrée d'insertion
      // (le 1er caractère existant dont la case est APRÈS la case de l'élément)
      const insertions = []; // {rawPos, glyph}
      for(const item of toInsert){
        let filteredInsert = glyphs.length;
        for(let p=0; p<glyphs.length; p++){
          if(posToCase[p] > item.caseIdx){ filteredInsert = p; break; }
        }
        // convertir en position RAW
        let rawPos;
        if(filteredInsert >= rawPosOfFiltered.length){ rawPos = raw.length; }
        else { rawPos = rawPosOfFiltered[filteredInsert]; }
        insertions.push({rawPos, glyph: item.glyph, caseIdx: item.caseIdx});
      }
      // trier les insertions par rawPos croissant, puis par caseIdx (pour l'ordre à position égale)
      insertions.sort((a,b) => (a.rawPos - b.rawPos) || (a.caseIdx - b.caseIdx));
      // insérer de gauche à droite en accumulant l'offset
      let offset = 0;
      let newVal = raw.slice();
      for(const ins of insertions){
        newVal.splice(ins.rawPos + offset, 0, ins.glyph);
        // ===== CAPTEUR MODÈLE (formule) =====
        // position dans le MODÈLE = nb de glyphes non-◌ avant la position d'insertion.
        if(typeof modelAdd === 'function'){
          let modelPos = 0;
          for(let q = 0; q < ins.rawPos + offset; q++){ if(newVal[q] !== DOT) modelPos++; }
          const cid = (CASES[ins.caseIdx] && CASES[ins.caseIdx].dataOptions) ? CASES[ins.caseIdx].dataOptions : null;
          modelAdd(ins.glyph, cid, modelPos);
        }
        offset++;
      }
      inputEl.value = newVal.join('');
      onInputChanged('clic-formule');
    }
    if(typeof pushHistory === 'function') pushHistory();
  }
  // Insère UN glyphe à sa position ordonnée selon l'index de sa case.
  function insertOneOrdered(glyph, clickedCaseIdx){
    const {glyphs, posToCase} = caseIdxOfChar();
    let insertPos = glyphs.length;
    for(let p=0; p<glyphs.length; p++){
      if(posToCase[p] > clickedCaseIdx){ insertPos = p; break; }
    }
    const raw = Array.from(inputEl.value);
    let rawPos = raw.length, cnt = 0;
    for(let i=0;i<raw.length;i++){
      if(raw[i] === DOT) continue;
      if(cnt === insertPos){ rawPos = i; break; }
      cnt++;
    }
    inputEl.value = raw.slice(0,rawPos).join('') + glyph + raw.slice(rawPos).join('');
    onInputChanged('clic-formule');
  }
  // Listeners de clic sur les cases de la formule
  CASES.forEach(c => {
    if(!c.span) return;
    c.span.style.cursor = 'pointer';
    c.span.addEventListener('click', (e) => {
      // pour une case interactive, le clic sur une OPTION du dropdown est géré ailleurs.
      // Ici : clic sur le glyphe principal (fixe, ou interactif déjà rempli).
      const isInter = isInteractive(c);
      const glyph = c.span.textContent;
      // ne rien faire si c'est une case interactive encore en 'undefined' (le dropdown gère)
      if(isInter){
        const opts = GROUPS[c.dataOptions] || [];
        const undef = opts.find(o => o.label === 'undefined');
        if(undef && glyph === undef.glyph) return; // undefined -> laisser le dropdown
      }
      if(!glyph) return;
      insertGlyphOrdered(glyph, c.idx);
      logFormulaClick(glyph, c.idx);
    });
  });

  document.querySelectorAll('.key').forEach(btn => {
    btn.addEventListener('click', () => {
      const glyph = btn.getAttribute('data-value');
      const v = inputEl.value;
      // position du curseur ; si le champ n'a jamais eu le focus, selectionStart peut
      // valoir la longueur (fin) — comportement par défaut souhaité.
      let start = inputEl.selectionStart;
      let end = inputEl.selectionEnd;
      if(start == null) start = v.length;
      if(end == null) end = v.length;
      inputEl.value = v.slice(0, start) + glyph + v.slice(end);
      // replacer le curseur juste après le glyph inséré
      const newPos = start + glyph.length;
      // garder le focus pour que selectionStart reste valide
      inputEl.focus();
      inputEl.setSelectionRange(newPos, newPos);
      onInputChanged('clic');
      logKeyboard(glyph);
    });
  });

  // édition manuelle de l'input (delete milieu, backspace, collage...)
  // Le modèle est réconcilié avec le champ dans onInputChanged sur reason 'edit'.
  inputEl.addEventListener('input', () => onInputChanged('edit'));

  // COPIER / COUPER : retirer les ◌ du presse-papier (ce sont des indicateurs, pas du contenu)
  function cleanClipboard(e){
    const sel = inputEl.value.substring(inputEl.selectionStart, inputEl.selectionEnd);
    const cleaned = sel.split(DOT).join('');
    e.clipboardData.setData('text/plain', cleaned);
    e.preventDefault();
  }
  inputEl.addEventListener('copy', cleanClipboard);
  inputEl.addEventListener('cut', (e) => {
    cleanClipboard(e);
    // pour 'cut', supprimer aussi la sélection de l'input
    const s = inputEl.selectionStart, en = inputEl.selectionEnd;
    inputEl.value = inputEl.value.slice(0,s) + inputEl.value.slice(en);
    inputEl.setSelectionRange(s, s);
    onInputChanged('cut');
  });
  // garder la miroir alignée lors du scroll horizontal (texte qui dépasse)
  inputEl.addEventListener('scroll', () => { mirrorEl.scrollLeft = inputEl.scrollLeft; });

  var _clearKey = document.querySelector('.clear-key');
  if(_clearKey) _clearKey.addEventListener('click', () => {
    inputEl.value = '';
    if(logEl) logEl.textContent = '';
    onInputChanged('clear');
    debugActions = [];
    refreshJournal();
  });

  // COPY : le site a un bouton .copy-key. Copier le champ SANS les ◌.
  var _copyKey = document.querySelector('.copy-key');
  if(_copyKey) _copyKey.addEventListener('click', () => {
    var cleaned = Array.from(inputEl.value).filter(function(c){ return c !== DOT; }).join('');
    if(navigator.clipboard){ navigator.clipboard.writeText(cleaned).catch(function(){}); }
    else {
      // fallback execCommand
      inputEl.select();
      try { document.execCommand('copy'); } catch(e){}
    }
  });

  // ===================== JOURNAL DE DEBUG =====================
  // Enregistre la séquence d'actions (clavier + clics) et affiche l'état présent
  // du champ texte et de la formule. Reset au Clear.
  let debugActions = [];
  function segLabelOf(caseIdx){
    // adresse lisible d'une case : doigt/subpart/bloc
    let part='?', sub='?', blk='';
    for(let i=caseIdx;i>=0;i--){
      if(CASES[i].kind==='sub part' && sub==='?'){ sub = CASES[i].title.split(':').pop().trim(); }
      if(CASES[i].kind==='part'){ part = CASES[i].title.split(':').pop().trim(); break; }
    }
    if(CASES[caseIdx].dataOptions){
      const parts = CASES[caseIdx].dataOptions.split('-');
      blk = parts[parts.length-1]; // flxext / abdadd / rinrex
    }
    return part+'/'+sub+(blk?('/'+blk):'');
  }
  function glyphName(g){
    // nom lisible d'un glyphe via la table clavier
    const b = document.querySelector('.key[data-value="'+g+'"]');
    if(b) return b.getAttribute('data-info') || g;
    // sinon chercher dans GROUPS
    for(const grp in GROUPS){ const o=(GROUPS[grp]||[]).find(o=>o.glyph===g); if(o) return o.label; }
    return 'U+'+(g?g.codePointAt(0).toString(16).toUpperCase():'?');
  }
  function logKeyboard(glyph){
    if(typeof refreshResolutionHighlight === 'function') refreshResolutionHighlight();
    debugActions.push({action:'[clavier] '+glyphName(glyph), champ:snapshotField(), formule:snapshotFormula()});
    refreshJournal();
  }
  function logFormulaClick(glyph, caseIdx){
    if(typeof refreshResolutionHighlight === 'function') refreshResolutionHighlight();
    debugActions.push({action:'[clic] '+glyphName(glyph)+' sur '+segLabelOf(caseIdx), champ:snapshotField(), formule:snapshotFormula()});
    refreshJournal();
  }
  function snapshotField(){
    // champ texte avec ◌ et indication des couleurs depuis la miroir
    const spans = Array.from(mirrorEl.querySelectorAll('.mirror-inner > span:not(.blink-caret)'));
    if(!spans.length) return inputEl.value ? Array.from(inputEl.value).map(c=>c==='◌'?'◌':glyphName(c)).join(' ') : '(vide)';
    return spans.map(s=>{
      const c = s.textContent;
      const n = c==='◌' ? '◌' : glyphName(c);
      if(s.classList.contains('ins-caret')){
        if(s.classList.contains('ins-caret-blue')) return '◌=BLEU';
        return '◌';
      }
      if(s.classList.contains('ch-wrong')) return n+'=R';
      if(s.classList.contains('ch-impact')) return n+'=O';
      return n;
    }).join(' ') || '(vide)';
  }
  function snapshotFormula(){
    // cases remplies/colorées de la formule, groupées par bloc
    const out = [];
    CASES.forEach((c,i) => {
      if(!c.dataOptions || !c.span) return;
      const s = c.span;
      let mark = null;
      if(s.classList.contains('errcell')) mark='R';
      else if(s.classList.contains('solcell')) mark='BLEU';
      else if(s.classList.contains('impactcell')) mark='O';
      else if(s.classList.contains('filled')) mark='v';
      if(mark){
        const g = glyphName(s.textContent);
        out.push(segLabelOf(i)+':'+g+'='+mark);
      }
    });
    return out.length ? out.join(' | ') : '(vide)';
  }
  function buildJournal(){
    const NL = String.fromCharCode(10);
    let txt = '';
    debugActions.forEach((a,i)=>{
      txt += (i+1)+'. '+a.action+NL;
      txt += '    CHAMP:   '+a.champ+NL;
      txt += '    FORMULE: '+a.formule+NL;
    });
    if(!debugActions.length){ txt += '(aucune action)'+NL; }
    return txt;
  }
  function refreshJournal(){
    const out = document.getElementById('journal-out');
    if(out) out.value = buildJournal();
  }
  var _btnCopyJournal = document.getElementById('btnCopyJournal');
  if(_btnCopyJournal) _btnCopyJournal.addEventListener('click', () => {
    const out = document.getElementById('journal-out');
    if(!out) return;
    out.select();
    try { document.execCommand('copy'); } catch(e){}
    if(navigator.clipboard){ navigator.clipboard.writeText(out.value).catch(()=>{}); }
  });
  // Accès console au journal de debug (le site n'a pas de textarea) :
  window.typannotJournal = function(){ var j = buildJournal(); console.log(j); return j; };
  window.typannotModel = function(){
    var out = MODEL.map(function(r,i){
      return i+': U+'+r.glyph.codePointAt(0).toString(16).toUpperCase()+' caseId='+(r.caseId||'(clavier)');
    }).join('\n');
    console.log(out); return MODEL;
  };
  // rafraîchir le journal après chaque recalcul (pour le snapshot champ/formule)
  const _origOnInput = onInputChanged;
  // (le snapshot est rafraîchi via les hooks de log ; on force aussi un refresh ici)

  log("Moteur v11 stateless prêt. "+CASES.length+" cases.");
  refreshJournal();
  // ---- (Peuplement des dropdowns : géré par le bloc CSV/window.GROUPS, PAS ici) ----
  // Le moteur ne fait QUE brancher hover + clic. Les options .possible_values
  // sont déjà créées par le bloc CSV au moment de 'groups-ready'.

  // ---- Hover ouvre le dropdown ; clic sur une option -> insertion ordonnée dans le champ ----
  CASES.forEach(c => {
    if(!c.dataOptions) return;
    const panel = c.el.querySelector('.possible_values');
    if(!panel) return;
    c.el.addEventListener('mouseenter', () => panel.classList.add('is_open'));
    c.el.addEventListener('mouseleave', () => panel.classList.remove('is_open'));
    panel.addEventListener('click', (e) => {
      const option = e.target.closest('.syntax_text');
      if(!option) return;
      e.stopPropagation();
      panel.classList.remove('is_open');
      // POINT 5 : si l'option cliquée est 'undefined', on VIDE le bloc (retrait),
      // au lieu d'insérer un glyphe. Détecté via le glyphe undefined du groupe.
      const grpOpts = (window.GROUPS && window.GROUPS[c.dataOptions]) ? window.GROUPS[c.dataOptions] : [];
      const undefOpt = grpOpts.find(o => o.label === 'undefined');
      if(undefOpt && option.textContent === undefOpt.glyph){
        removeGlyphFromCase(c.idx);
        logFormulaClick('undefined', c.idx);
        return;
      }
      insertGlyphOrdered(option.textContent, c.idx);
      logFormulaClick(option.textContent, c.idx);
    });
  });

  // ===== CONTEXTE DE RÉSOLUTION (curseur ↔ ◌) =====
  function resolutionContext(){
    if(!lastHoleInfos.length) return {hole:null, glyphs:[], targetCase:-1};
    const caret = inputEl.selectionStart;
    let hole = null;
    for(const h of lastHoleInfos){
      if(caret === h.rawPos || caret === h.rawPos + 1){ hole = h; break; }
    }
    if(!hole) return {hole:null, glyphs:[], targetCase:-1};
    const targetCase = hole.target;
    let glyphs = [];
    // Les glyphes résolvants dépendent du KIND du manque, pas seulement de la case cible.
    if(hole.kind === 'need_subpart'){
      // il manque une subpart -> proposer toutes les subparts du doigt
      glyphs = Object.values(SUBPART_GLYPHS);
    } else if(hole.kind === 'need_part'){
      // il manque une part -> proposer les parts
      glyphs = Object.values(PART_GLYPHS);
    } else if(targetCase >= 0 && CASES[targetCase] && CASES[targetCase].dataOptions){
      // need_subvar / value_due -> options interactives du bloc cible
      const opts = GROUPS[CASES[targetCase].dataOptions] || [];
      glyphs = opts.filter(o => o.label !== 'undefined').map(o => o.glyph);
      // FILTRE REF POS : si la VALUE de ce bloc (case targetCase+1) est déjà posée et NON-zero,
      // ref pos n'est pas une solution valide (il est lié à zero). On le retire des propositions.
      if(hole.kind === 'need_subvar'){
        const valCase = targetCase + 1;
        if(CASES[valCase] && CASES[valCase].kind === 'value'){
          const _g = toGlyphs(inputEl.value);
          const _r = validate(_g, (typeof modelCaseIds==='function'?modelCaseIds():[]));
          const vs = _r.st[valCase];
          const valuePosedNonZero = vs && (vs.filled || vs.orphan) && vs.glyph && vs.glyph !== G_ZERO;
          if(valuePosedNonZero){
            glyphs = glyphs.filter(g => g !== G_REFPOS);
          }
        }
      }
    } else if(targetCase >= 0 && CASES[targetCase] && CASES[targetCase].fixedGlyph){
      glyphs = [CASES[targetCase].fixedGlyph];
    }
    return {hole, glyphs, targetCase};
  }
  function refreshResolutionHighlight(){
    const ctx = resolutionContext();
    const spans = Array.from(mirrorEl.querySelectorAll('.mirror-inner > span:not(.blink-caret)'));
    spans.forEach(s => s.classList.remove('ins-caret-blue'));
    // Déterminer le ◌ ACTIF : celui sous le curseur, sinon le DERNIER créé TEMPORELLEMENT.
    let activeHole = ctx.hole;
    if(!activeHole && lastHoleInfos.length){
      // dernier créé temporellement (pas le plus à droite spatialement)
      activeHole = lastHoleInfos.find(h => h.target === lastCreatedHoleTarget)
                   || lastHoleInfos[lastHoleInfos.length - 1];
    }
    // ◌ bleu dans le champ (seulement si curseur dessus)
    if(ctx.hole && spans[ctx.hole.rawPos]){
      spans[ctx.hole.rawPos].classList.add('ins-caret-blue');
    }
    // touches clavier bleues (seulement si curseur sur un ◌)
    const resoSet = new Set(ctx.glyphs);
    const resolutionActive = resoSet.size > 0; // curseur sur un ◌ avec des glyphes proposés
    document.querySelectorAll('.key').forEach(btn => {
      const g = btn.getAttribute('data-value');
      if(resolutionActive){
        if(resoSet.has(g)){
          // touche qui résout -> bleu
          btn.classList.add('key-reso-blue');
          btn.classList.remove('key-reso-red');
        } else {
          // toute autre touche -> rouge (invalide tant que le ◌ n'est pas résolu)
          btn.classList.add('key-reso-red');
          btn.classList.remove('key-reso-blue');
        }
      } else {
        // hors résolution : aucune touche colorée
        btn.classList.remove('key-reso-blue');
        btn.classList.remove('key-reso-red');
      }
    });
    // Undefined de la FORMULE : le bloc ACTIF reste BLEU (solcell), les AUTRES need glyphs
    // passent en ROUGE (errcell) — ils sont en attente, pas le focus courant.
    const activeTarget = activeHole ? activeHole.target : -1;
    // l'ensemble des cases cibles de TOUS les ◌ (need glyphs)
    const allHoleTargets = new Set(lastHoleInfos.map(h => h.target).filter(t => t >= 0));
    CASES.forEach((c,i) => {
      if(!c.span) return;
      const isHoleTarget = allHoleTargets.has(i);
      if(!isHoleTarget) return; // ne toucher qu'aux cases qui sont des ◌ (need glyphs)
      // retirer les marques de résolution avant de re-décider
      c.span.classList.remove('solcell');
      if(i === activeTarget){
        // bloc actif -> bleu
        c.span.classList.remove('errcell');
        if(!c.span.classList.contains('filled')) c.span.classList.add('solcell');
      } else {
        // need glyph en attente -> rouge (comme une faute)
        if(!c.span.classList.contains('filled')) c.span.classList.add('errcell');
      }
    });
    return ctx;
  }
  inputEl.addEventListener('keyup', refreshResolutionHighlight);
  inputEl.addEventListener('click', refreshResolutionHighlight);
  inputEl.addEventListener('select', refreshResolutionHighlight);

  // ===== CURSEUR CLIGNOTANT custom (toujours visible dans la miroir) =====
  function placeBlinkCaret(){
    const inner = mirrorEl.querySelector('.mirror-inner');
    if(!inner) return;
    // retirer l'ancien curseur
    const old = inner.querySelector('.blink-caret');
    if(old) old.remove();
    const caret = document.createElement('span');
    caret.className = 'blink-caret';
    const pos = inputEl.selectionStart;
    const spans = Array.from(inner.querySelectorAll('span:not(.blink-caret)'));
    if(pos <= 0){
      inner.insertBefore(caret, inner.firstChild);
    } else if(pos >= spans.length){
      inner.appendChild(caret);
    } else {
      inner.insertBefore(caret, spans[pos]);
    }
  }
  // replacer le curseur après chaque changement et mouvement
  inputEl.addEventListener('keyup', placeBlinkCaret);
  inputEl.addEventListener('click', placeBlinkCaret);
  inputEl.addEventListener('select', placeBlinkCaret);
  inputEl.addEventListener('input', () => setTimeout(placeBlinkCaret, 0));

  // ===== UNDO / REDO par historique d'états =====
  // Chaque action complète pousse la valeur du champ dans la pile. Le moteur étant
  // stateless, restaurer la valeur suffit à restaurer tout l'état.
  let undoStack = [];   // états passés (valeurs du champ, SANS les ◌)
  let redoStack = [];   // états annulés (pour redo)
  let isUndoRedo = false; // évite d'enregistrer les changements dus à undo/redo
  let histSuspended = false; // suspend l'enregistrement pendant une action multi-caractères
  function cleanValueOf(v){ return Array.from(v).filter(c => c !== DOT).join(''); }
  function snapshotModel(){
    // copie profonde des recs (pour l'undo/redo)
    return (typeof MODEL !== 'undefined') ? MODEL.map(r => ({id:r.id, glyph:r.glyph, caseId:r.caseId})) : [];
  }
  function pushHistory(){
    if(isUndoRedo || histSuspended) return;
    const clean = cleanValueOf(inputEl.value);
    // ne pas empiler si identique au sommet (comparaison sur le texte)
    if(undoStack.length && undoStack[undoStack.length-1].text === clean) return;
    undoStack.push({ text: clean, model: snapshotModel() });
    redoStack = []; // une nouvelle action invalide le redo
    if(undoStack.length > 200) undoStack.shift(); // limite mémoire
  }
  function applyHistoryValue(snap){
    isUndoRedo = true;
    // snap peut être un objet {text, model} ou (compat) une chaîne
    const text = (snap && typeof snap === 'object') ? snap.text : (snap || '');
    inputEl.value = text;
    // restaurer le MODÈLE depuis le snapshot
    if(typeof MODEL !== 'undefined'){
      if(snap && typeof snap === 'object' && snap.model){
        MODEL = snap.model.map(r => ({id:r.id, glyph:r.glyph, caseId:r.caseId}));
      } else {
        MODEL = [];
      }
    }
    inputEl.dispatchEvent(new Event('input'));
    isUndoRedo = false;
    if(typeof refreshResolutionHighlight === 'function') refreshResolutionHighlight();
  }
  function doUndo(){
    if(undoStack.length <= 1){
      // rien à annuler au-delà de l'état initial : vider le champ si un seul état
      if(undoStack.length === 1 && cleanValueOf(inputEl.value) !== ''){
        redoStack.push(undoStack.pop());
        applyHistoryValue({ text: '', model: [] });
        undoStack.push({ text: '', model: [] });
      }
      return;
    }
    const current = undoStack.pop();
    redoStack.push(current);
    const prev = undoStack[undoStack.length - 1];
    applyHistoryValue(prev);
  }
  function doRedo(){
    if(!redoStack.length) return;
    const v = redoStack.pop();
    undoStack.push(v);
    applyHistoryValue(v);
  }
  // Brancher sur les boutons (structure du site : .delete-key = undo, .redo-key = redo)
  const undoBtn = document.querySelector('.delete-key');
  const redoBtn = document.querySelector('.redo-key');
  if(undoBtn) undoBtn.addEventListener('click', doUndo);
  if(redoBtn) redoBtn.addEventListener('click', doRedo);
  // Raccourcis clavier Cmd/Ctrl+Z (undo) et Cmd/Ctrl+Shift+Z (redo)
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if(mod && (e.key === 'z' || e.key === 'Z')){
      e.preventDefault();
      if(e.shiftKey) doRedo(); else doUndo();
    }
  });

  // Hover sur un undefined BLEU (solcell) de la formule -> surligner en bleu le ◌ qu'il résout.
  // Le ◌ résolu par une case = celui dont hole.target correspond à cette case (ou son bloc).
  function holeForFormulaCase(caseIdx){
    // trouver le ◌ (dans lastHoleInfos) dont la target est ce bloc.
    // Pour un undefined subvar (solcell), le ◌ associé a target === caseIdx (need_subvar).
    for(const h of lastHoleInfos){
      if(h.target === caseIdx) return h;
    }
    return null;
  }
  CASES.forEach(c => {
    if(!c.span) return;
    c.span.addEventListener('mouseenter', () => {
      if(!c.span.classList.contains('solcell')) return; // seulement les undefined bleus
      const h = holeForFormulaCase(c.idx);
      const spans = Array.from(mirrorEl.querySelectorAll('.mirror-inner > span:not(.blink-caret)'));
      spans.forEach(s => s.classList.remove('ins-caret-hover-blue'));
      if(h && spans[h.rawPos]) spans[h.rawPos].classList.add('ins-caret-hover-blue');
    });
    c.span.addEventListener('mouseleave', () => {
      const spans = Array.from(mirrorEl.querySelectorAll('.mirror-inner > span:not(.blink-caret)'));
      spans.forEach(s => s.classList.remove('ins-caret-hover-blue'));
    });
  });

  // ===== HOVER VIOLET : correspondance champ <-> formule =====
  // Convertit une position FILTRÉE (sans ◌) en position RAW dans la miroir.
  function filteredToRaw(fpos){
    const raw = Array.from(inputEl.value);
    let cnt = 0;
    for(let i=0;i<raw.length;i++){
      if(raw[i] === DOT) continue;
      if(cnt === fpos) return i;
      cnt++;
    }
    return -1;
  }
  function clearViolet(){
    document.querySelectorAll('.framework .syntax_text.link-violet').forEach(e => e.classList.remove('link-violet'));
    mirrorEl.querySelectorAll('span.link-violet').forEach(e => e.classList.remove('link-violet'));
  }
  // Hover sur une CASE FORMULE remplie -> violet sur le(s) caractère(s) source du champ
  // + toutes les cases formule partageant le même srcChar (cascade/linkage).
  function violetFromFormula(caseIdx){
    clearViolet();
    if(!lastResult || !lastResult.st) return;
    const s = lastResult.st[caseIdx];
    if(!s || s.srcChar < 0) return;
    const src = s.srcChar;
    // hover FORMULE -> violet UNIQUEMENT dans le CHAMP (le caractère source).
    const rawPos = filteredToRaw(src);
    if(rawPos >= 0){
      const sp = mirrorEl.querySelector('.mirror-inner > span[data-rawidx="'+rawPos+'"]');
      if(sp) sp.classList.add('link-violet');
    }
  }
  // Hover sur un CARACTÈRE du champ -> violet sur toutes les cases formule qu'il a générées.
  function violetFromField(rawIdx){
    clearViolet();
    if(!lastResult || !lastResult.st) return;
    // convertir rawIdx en position filtrée
    const raw = Array.from(inputEl.value);
    if(raw[rawIdx] === DOT) return; // pas de correspondance pour un ◌
    let fpos = 0;
    for(let i=0;i<rawIdx;i++){ if(raw[i] !== DOT) fpos++; }
    // hover CHAMP -> violet UNIQUEMENT dans la FORMULE (les cases générées).
    lastResult.st.forEach((st2,i) => {
      if(st2.srcChar === fpos && (st2.filled || st2.typed) && CASES[i].span){
        CASES[i].span.classList.add('link-violet');
      }
    });
  }
  // Listeners hover sur les cases formule (violet)
  CASES.forEach(c => {
    if(!c.span) return;
    c.span.addEventListener('mouseenter', () => {
      // seulement si la case est remplie/tapée (a une correspondance)
      if(lastResult && lastResult.st[c.idx] && (lastResult.st[c.idx].filled || lastResult.st[c.idx].typed)){
        violetFromFormula(c.idx);
      }
    });
    c.span.addEventListener('mouseleave', clearViolet);
  });
  // Listeners hover sur les caractères du champ (délégation sur la miroir)
  // L'input est transparent AU-DESSUS de la miroir : les events souris vont à l'input.
  // On détecte le caractère survolé via la position X de la souris.
  inputEl.addEventListener('mousemove', (e) => {
    const spans = Array.from(mirrorEl.querySelectorAll('.mirror-inner > span[data-rawidx]:not(.blink-caret)'));
    if(!spans.length){ clearViolet(); return; }
    const x = e.clientX;
    let found = null;
    for(const sp of spans){
      const r = sp.getBoundingClientRect();
      if(x >= r.left && x <= r.right){ found = sp; break; }
    }
    if(found){
      violetFromField(parseInt(found.getAttribute('data-rawidx'),10));
    } else {
      clearViolet();
    }
  });
  inputEl.addEventListener('mouseleave', clearViolet);

  // ===== POINT 7 : BOUTON COPIER LA FORMULE COMPLÈTE =====
  // Copie la suite des glyphes de TOUTES les cases de la formule (fixes + interactives),
  // y compris les 'undefined' (le glyphe réellement affiché dans chaque case).
  function fullFormulaString(){
    let out = '';
    CASES.forEach(c => {
      if(!c.span) return;
      const g = c.span.textContent || '';
      out += g;
    });
    return out;
  }
  (function addCopyFormulaButton(){
    if(!formulaEl) return;
    // conteneur positionné : la formule doit être relative pour ancrer le bouton
    const host = formulaEl;
    const cs = getComputedStyle(host);
    if(cs.position === 'static'){ host.style.position = 'relative'; }
    const COPY_IMG = 'https://cdn.prod.website-files.com/6a4537670fb4404edba2a7bb/6a4537670fb4404edba2a7c6_noun-copy-1485763.svg';
    const btn = document.createElement('div');
    btn.title = 'Copier la formule complète';
    btn.setAttribute('aria-label','Copier la formule complète');
    btn.style.cssText = 'position:absolute;top:6px;right:6px;z-index:50;cursor:pointer;'
      + 'width:1.4em;height:1.4em;user-select:none;opacity:.75;';
    const img = document.createElement('img');
    img.src = COPY_IMG;
    img.alt = 'Copier';
    img.style.cssText = 'width:100%;height:100%;display:block;';
    btn.appendChild(img);
    btn.addEventListener('mouseenter', ()=>{ btn.style.opacity = '1'; });
    btn.addEventListener('mouseleave', ()=>{ btn.style.opacity = '.75'; });
    btn.addEventListener('click', () => {
      const txt = fullFormulaString();
      if(navigator.clipboard){ navigator.clipboard.writeText(txt).catch(()=>{}); }
      btn.style.opacity = '.3';
      setTimeout(()=>{ btn.style.opacity = '.75'; }, 500);
    });
    host.appendChild(btn);
  })();

  onInputChanged('init');
  console.log('[moteur] Typannot démarré — ' + CASES.length + ' cases.');
}

// ---- DÉMARRAGE SYNCHRONISÉ ----
// Le moteur a besoin de window.GROUPS (fourni par le bloc CSV, asynchrone).
// On démarre soit tout de suite si GROUPS est déjà prêt, soit sur l'événement
// 'groups-ready' émis par le bloc CSV.
(function(){
  function tryStart(){
    if(window.GROUPS && Object.keys(window.GROUPS).length){
      startTypannotEngine();
      return true;
    }
    return false;
  }
  // 1) si déjà prêt (CSV revenu avant ce script)
  if(tryStart()) return;
  // 2) sinon, attendre le signal du bloc CSV
  window.addEventListener('groups-ready', tryStart);
  // 3) filet de sécurité : re-tester après quelques délais au cas où l'événement
  //    aurait été émis avant l'attachement de l'écouteur.
  var tries = 0;
  var iv = setInterval(function(){
    tries++;
    if(tryStart() || tries > 40){ clearInterval(iv); } // ~10s max
  }, 250);
})();
