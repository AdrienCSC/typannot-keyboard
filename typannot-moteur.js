/* ============================================================
   TYPANNOT — MOTEUR MULTI-PAGES — v4.28 (◌ en SVG via IMG injecte: le ◌ est rendu comme un <img> SVG dans le mirror (rond=structurel need_part/subpart/selection/subselection, carre=valeur need_var/subvar/var_or_subvar/value_due). Couleur par le src: rouge=manque, bleu=◌ actif de resolution (bascule dans refreshResolutionHighlight). Le caractere ◌ reste dans inputEl.value, seul le rendu change. Plus de background moche)
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
  // ===== R01c — Branches d'ancrage valides par page (liste blanche codée en dur) =====
  // La hiérarchie d'ancrage N'EST PAS fixe entre pages (body: part>SEL ; upper-limb: SEL>part).
  // On ne peut donc pas coder un barème part<selection en dur. Chaque page déclare ses branches
  // (chemin var/subvar -> ... -> sommet). La PROFONDEUR d'un niveau ancrant se lit dans la
  // branche : plus on est haut (proche du sommet), plus la profondeur est PETITE (racine=1).
  //
  // Détection de page : document.title ("Posture - Body 2.6", "Posture - Upper Limb 2.6"...),
  // seul discriminant fiable (upper-limb et body ont les mêmes kinds présents).
  //
  // Une branche est écrite du SOMMET (racine d'ancrage) vers le bas (juste au-dessus de la
  // var/subvar). L'AS est racine implicite de plus haut niveau, au-dessus de toute branche.
  // ===== TABLE 1 — HIÉRARCHIE des anchor levels par page =====
  // L'ordre d'emboîtement des niveaux, du plus HAUT (A1, sous l'AS) au plus BAS. Sert à calculer
  // les anchor levels (A1/A2/A3...), la chaîne d'ancrage et la cascade. C'est PUREMENT la
  // hiérarchie « qui est sous qui » — RIEN à voir avec les funnels (Table 2, restrictions de
  // possibilités). Une page = une seule chaîne d'emboîtement. Les niveaux absents sur un cas
  // précis (ex : jaw n'a pas de subpart) se déduisent de la formule (P03), pas de la table.
  const ANCHOR_HIERARCHY = {
    finger:      ['selection','part','sub part'],
    'upper-limb':['selection','part'],
    body:        ['part','selection'],
    lowerface:   ['part','sub part','subselection'],
    upperface:   ['part','selection','sub part','subselection'],
  };
  // ===== TABLE 3 — SKIP : niveaux SKIPABLES par page ===== (voir après detectPage)
  // Deux familles de skip : (a) niveaux ANCRANTS omissibles (selection sur finger/upper-limb) ;
  // (b) la VARIABLE, skipable partout (pattern universel var>subvar>value : on peut poser la
  // subvar sans passer par la variable). R14 : tolérance de ce qu'on a le droit de NE PAS écrire.
  const ANCHOR_SKIPPABLE = {
    finger:      ['selection','variable'],
    'upper-limb':['selection','variable'],
    body:        ['variable'],
    lowerface:   ['variable'],
    upperface:   ['variable'],
  };

  // La hiérarchie (chaîne unique) exposée comme branche unique pour construire les relations
  // parent->enfant (ANCHOR_PARENTS).
  const ANCHOR_BRANCHES = {
    finger:      [ ANCHOR_HIERARCHY.finger ],
    'upper-limb':[ ANCHOR_HIERARCHY['upper-limb'] ],
    body:        [ ANCHOR_HIERARCHY.body ],
    lowerface:   [ ANCHOR_HIERARCHY.lowerface ],
    upperface:   [ ANCHOR_HIERARCHY.upperface ],
  };
  function detectPage(){
    const t = (document.title||'').toLowerCase();
    if(t.includes('upper limb') || t.includes('upper-limb')) return 'upper-limb';
    if(t.includes('lowerface') || t.includes('lower face')) return 'lowerface';
    if(t.includes('upperface') || t.includes('upper face')) return 'upperface';
    if(t.includes('body')) return 'body';
    if(t.includes('finger')) return 'finger';
    return 'finger'; // défaut sûr (page historique)
  }
  const PAGE = detectPage();
  const PAGE_BRANCHES = ANCHOR_BRANCHES[PAGE] || ANCHOR_BRANCHES.finger;
  // niveaux skipables de la page courante (Table 3)
  const SKIP_SET = new Set(ANCHOR_SKIPPABLE[PAGE] || []);
  function isSkippableKind(kind){ return SKIP_SET.has(kind); }

  // Relations parent->enfant autorisées, extraites des branches R01c de la page. Un même kind
  // peut avoir des parents différents selon la branche (upperface : selection est enfant de part
  // en branche C, mais parent de subpart en branche A ; nose : part->subpart sans selection).
  // Aucun barème kind->niveau ne peut encoder ça : on garde les RELATIONS, pas des niveaux.
  // 'as' est parent implicite de tout sommet de branche.
  const ANCHOR_PARENTS = (function(){
    const parents = {}; // kind -> Set(kinds parents possibles)
    const add=(child,parent)=>{ (parents[child]||(parents[child]=new Set())).add(parent); };
    PAGE_BRANCHES.forEach(branch => {
      // branch = [sommet, ..., plus bas]. sommet a pour parent 'as'.
      branch.forEach((kind,i) => {
        if(i===0) add(kind,'as');
        else add(kind, branch[i-1]);
      });
    });
    return parents;
  })();
  function isChildOf(childKind, parentKind){
    const set = ANCHOR_PARENTS[childKind];
    return !!(set && set.has(parentKind));
  }
  // RANG d'un kind ancrant dans la hiérarchie de la page (Table 1). AS = 0 (le plus haut),
  // puis 1, 2, 3... vers le bas. Sert à l'empilement UNIVERSEL : une ancre s'empile sous la
  // première ancre de rang STRICTEMENT plus haut (rang plus petit), quel que soit son kind.
  // Ainsi le parent effectif est LU dans la formule (l'ancre réelle au-dessus), pas imposé par
  // un parent nommé unique — ce qui gère les pages où un niveau peut être sauté (upperface :
  // nose -> subpart sans selection ; eyelids -> selection -> subpart).
  const HIER = ANCHOR_HIERARCHY[PAGE] || [];
  function anchorRank(kind){
    if(kind === 'as') return 0;
    const i = HIER.indexOf(kind);
    return i < 0 ? 99 : (i + 1); // inconnu -> très bas
  }
  function isAnchorKind(kind){
    return kind==='as' || (kind in ANCHOR_PARENTS);
  }
  // nom lisible extrait d'un title "Kind: name" -> "name"
  function nameFromTitle(title){
    const m = (title||'').split(':');
    return m.length>1 ? m.slice(1).join(':').trim() : (title||'').trim();
  }
  const CASES = [];
  // Pile d'ancres PERSISTANTE à travers les framework_wrap : les wraps sont un découpage de mise
  // en page Webflow, PAS des frontières sémantiques. L'AS (racine) et les parts peuvent vivre
  // dans des wraps différents ; la chaîne d'ancrage doit rester continue. (Seule la ponctuation
  // "part end" ferme une part — en gardant l'AS.)
  let anchorStack = [];
  formulaEl.querySelectorAll('.framework_wrap').forEach(fw => {
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
      // Empilement par RELATIONS parent->enfant (R01c), pas par barème de niveau.
      // À l'arrivée d'une ancre E : on dépile tant que le sommet de pile n'est PAS un parent
      // autorisé de E (on remonte jusqu'au bon parent, quel que soit son kind sur cette page).
      // Puis E s'empile SOUS ce parent. AS = racine (vide la pile). Ponctuation vide tout.
      // La profondeur d'une ancre = sa position dans la pile (0 = AS/racine).
      // La ponctuation ("part end", "annot end") est un REPÈRE VISUEL pour l'utilisateur, pas
      // une frontière sémantique : elle ne modifie PAS la pile d'ancrage. Toute la hiérarchie se
      // décide par les anchor levels (relations parent->enfant R01c), jamais par la ponctuation.
      if(kind === 'as'){
        anchorStack = [{ depth:0, kind:'as', name:nameFromTitle(title), glyph:fixedGlyph, caseIdx:idx }];
      } else if(isAnchorKind(kind)){
        // EMPILEMENT PAR RANG (universel) : le parent effectif est l'ancre réellement présente
        // au-dessus dans la formule, du moment qu'elle est de rang strictement plus haut. On
        // dépile tant que le sommet est de rang >= celui de E (même niveau ou plus bas = pas un
        // parent). On s'arrête au 1er sommet de rang strictement plus haut, quel que soit son
        // kind. Gère les niveaux sautés (nose->subpart sans selection) sans parent nommé unique.
        const rE = anchorRank(kind);
        while(anchorStack.length){
          const top = anchorStack[anchorStack.length-1];
          if(anchorRank(top.kind) < rE) break;      // sommet strictement plus haut = parent effectif
          anchorStack.pop();
        }
        const depth = anchorStack.length;            // profondeur = sous le parent trouvé
        anchorStack.push({ depth:depth, kind:kind, name:nameFromTitle(title), glyph:fixedGlyph, caseIdx:idx });
      }
      // chaîne d'ancres de CETTE case = copie de la pile courante (sommet -> bas)
      const anchorChain = anchorStack.map(a => ({level:a.depth, kind:a.kind, name:a.name, glyph:a.glyph, caseIdx:a.caseIdx}));
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

  // ============================================================================
  // PRIMITIVES D'ANCRAGE UNIVERSELLES
  // ----------------------------------------------------------------------------
  // Toute règle syntaxique raisonne en NIVEAUX RELATIFS (parent = -1, enfant = +1, sommet,
  // niveau le plus bas...), lus depuis anchorChain. AUCUNE règle ne nomme un niveau ('part',
  // 'sub part', ...). Le vocabulaire spécifique ne vit QUE dans le mapping DOM->kind
  // (kindFromTitle) et la table de branches R01c. Les niveaux se calculent, ils ne se nomment pas.
  //
  // anchorChain d'une case = [{level, kind, glyph, caseIdx}, ...] du sommet (level 0 = AS/racine)
  // vers le bas. Pour une case interactive (bloc), ce sont ses ancres parentes.

  // Profondeur d'ancrage d'une CASE (= longueur de sa chaîne si c'est une ancre ; 0 sinon).
  function anchorDepthOf(caseIdx){
    const c = CASES[caseIdx];
    if(!c || !isAnchorKind(c.kind)) return 0;
    return c.anchorChain ? c.anchorChain.length : 0;
  }
  // La chaîne d'ancres parentes d'une case (maillons AU-DESSUS d'elle). Pour une ancre, on
  // exclut le maillon qui est elle-même. Retourne [{level, kind, glyph, caseIdx}, ...].
  function parentChainOf(caseIdx){
    const c = CASES[caseIdx];
    if(!c || !c.anchorChain) return [];
    if(isAnchorKind(c.kind)){
      // c est une ancre : sa chaîne l'inclut en dernier -> retirer le maillon == caseIdx
      return c.anchorChain.filter(a => a.caseIdx !== caseIdx);
    }
    return c.anchorChain.slice(); // bloc : toute la chaîne est parente
  }
  // Le caseIdx de l'ancre parente de niveau donné (0 = racine/AS) dans la chaîne d'une case.
  function anchorCaseAtLevel(caseIdx, level){
    const chain = (CASES[caseIdx] && CASES[caseIdx].anchorChain) || [];
    for(const a of chain){ if(a.level === level) return a.caseIdx; }
    return -1;
  }
  // L'ancre parente IMMÉDIATE d'une case (niveau le plus profond de sa chaîne parente = -1).
  // Retourne le caseIdx, ou -1 si aucune (case sous la seule racine / sans parent ancrant).
  function immediateParentAnchor(caseIdx){
    const pc = parentChainOf(caseIdx);
    if(!pc.length) return -1;
    // le parent immédiat = maillon de plus grand level (le plus bas dans la hiérarchie)
    let best = pc[0];
    for(const a of pc){ if(a.level > best.level) best = a; }
    return best.caseIdx;
  }
  // Toutes les ancres parentes d'une case, du plus BAS (immédiat) au plus HAUT (racine).
  // Utile pour retirer/vérifier la colonne d'ancrage complète, sans nommer aucun niveau.
  function parentAnchorsBottomUp(caseIdx){
    const pc = parentChainOf(caseIdx).filter(a => a.kind !== 'as'); // hors racine AS
    pc.sort((x,y) => y.level - x.level); // du plus bas (level élevé) au plus haut
    return pc.map(a => a.caseIdx);
  }
  // Frontière de portée générique : depuis une ancre `anchorIdx`, l'index de fin (exclu) de sa
  // sous-arborescence = 1re case dont l'ancre est de niveau <= celui de anchorIdx. Ponctuation
  // NEUTRE (repère visuel), jamais une frontière. C'est LA borne universelle des règles.
  function scopeEndOf(anchorIdx){
    const L = anchorDepthOf(anchorIdx);
    for(let k=anchorIdx+1;k<CASES.length;k++){
      if(isAnchorKind(CASES[k].kind) && anchorDepthOf(k) <= L) return k;
    }
    return CASES.length;
  }
  // Y a-t-il un bloc interactif (subvar) rempli dans la sous-arborescence d'une ancre ?
  // (générique, remplace tous les "segmentHasContent" nommés). st = agencement d'un validate.
  function subtreeHasFilledBlock(anchorIdx, st){
    const end = scopeEndOf(anchorIdx);
    for(let k=anchorIdx+1;k<end;k++){
      if(isInteractive(CASES[k]) && CASES[k].kind==='sub variable' && st[k] && st[k].filled) return true;
    }
    return false;
  }
  // Kind de manque associé à un kind ancrant (universel, partagé). need_<niveau>.
  function needKindOfAnchor(anchorKind){
    switch(anchorKind){
      case 'selection':    return 'need_selection';
      case 'part':         return 'need_part';
      case 'sub part':     return 'need_subpart';
      case 'subselection': return 'need_subselection';
      default:             return 'need_part';
    }
  }
  // ============================================================================
  // CASCADE ref pos / zero (niveau module, accessible à l'aligneur). Poser ref pos sur une ancre
  // remplit tous les blocs {subvar, value} de SA PORTÉE avec les couples ref pos + zero linkés.
  // La portée intègre la RÈGLE DU CARACTÈRE : une ancre de même niveau ne borne QUE si son
  // glyphe DIFFÈRE (même glyphe = même ancre fragmentée, ex lips ×4 -> traverse).
  function isScopeBoundaryMod(anchorIdx, k){
    if(!isAnchorKind(CASES[k].kind)) return false;
    const L = anchorDepthOf(anchorIdx);
    const dk = anchorDepthOf(k);
    if(dk < L) return true;                        // remonté au-dessus -> frontière
    if(dk === L){                                  // même niveau : dépend du caractère
      return CASES[k].fixedGlyph !== CASES[anchorIdx].fixedGlyph; // glyphe diff -> frontière
    }
    return false;                                  // plus bas -> dans la sous-arborescence
  }
  // Les blocs {sub, val} de la portée d'une ancre (règle du caractère incluse).
  function blocksUnderAnchorMod(anchorIdx){
    const L = anchorDepthOf(anchorIdx);
    if(L === 0 && CASES[anchorIdx].kind !== 'as' && !isAnchorKind(CASES[anchorIdx].kind)) return [];
    const blocks = [];
    for(let k=anchorIdx+1;k<CASES.length;k++){
      if(isScopeBoundaryMod(anchorIdx, k)) break;
      const ck = CASES[k].kind;
      if(ck==='sub variable' && isInteractive(CASES[k])) blocks.push({sub:k, val:null});
      if(ck==='value' && isInteractive(CASES[k]) && blocks.length){
        const last = blocks[blocks.length-1];
        if(last.val==null) last.val=k;
      }
    }
    return blocks;
  }
  // Dernière case de la portée d'une ancre (même frontière).
  function endOfAnchorScopeMod(anchorIdx){
    let last = anchorIdx;
    for(let k=anchorIdx+1;k<CASES.length;k++){
      if(isScopeBoundaryMod(anchorIdx, k)) break;
      last = k;
    }
    return last;
  }
  // ============================================================================
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
  // ============================================================================
  // ALIGNEUR st ↔ FORMULE — LE moteur de vérité. La formule de la page (séquence de cases,
  // chacune portant kind + anchorChain + glyphes acceptés + skip) EST la spécification
  // grammaticale. Le validateur ne code AUCUNE règle : il aligne les recs (st) sur la séquence
  // de cases et détecte où st DIVERGE de la formule. Toutes les règles (ordre, doublon, ancrage,
  // abandon, glyphe sauvage) ÉMERGENT de cet alignement. Erreurs ET résolutions = deux lectures
  // du même diff. Universel : rien de spécifique à une page, tout est lu depuis les CASES.
  // ----------------------------------------------------------------------------

  // Une case accepte-t-elle ce glyphe ? (LE SHEET : fixedGlyph absolu OU une option dataOptions).
  // undefined est accepté partout où il y a une option 'undefined'. C'est la 2e source de vérité.
  function caseAccepts(caseIdx, glyph){
    const c = CASES[caseIdx];
    if(!c) return false;
    if(c.fixedGlyph != null) return c.fixedGlyph === glyph;
    if(c.dataOptions){
      const opts = GROUPS[c.dataOptions] || [];
      return opts.some(o => o.glyph === glyph);
    }
    return false;
  }
  // Le glyphe est-il l'option 'undefined' de cette case ?
  function caseAcceptsAsUndef(caseIdx, glyph){
    const c = CASES[caseIdx];
    if(!c || !c.dataOptions) return false;
    const opts = GROUPS[c.dataOptions] || [];
    const u = opts.find(o => o.label === 'undefined');
    return !!u && u.glyph === glyph;
  }
  // Kind du glyphe, lu depuis la page (clavier fiable, sinon cases). Sert à l'aligneur pour
  // savoir à quel TYPE de case ce glyphe pourrait correspondre (LA FORMULE : type attendu).
  function glyphKindGlobal(g){
    if(KEYBOARD_KIND[g]) return KEYBOARD_KIND[g];
    for(const c of CASES){ if(c.fixedGlyph===g) return c.kind; }
    for(const c of CASES){
      if(isInteractive(c)){
        const opts=GROUPS[c.dataOptions]||[];
        if(opts.some(o=>o.glyph===g && o.label!=='undefined')) return c.kind;
      }
    }
    return '?';
  }
  // Une case-ancre est-elle "posée" dans st ? RÈGLE DU CARACTÈRE : deux ancres de MÊME GLYPHE
  // sont la même ancre (la formule fragmente une ancre en plusieurs occurrences ; ex nose
  // apparaît 2× sur upper face, lips 4× sur lower face). Donc l'ancre @anchorCaseIdx est
  // satisfaite si SON glyphe est posé sur N'IMPORTE laquelle de ses occurrences.
  function anchorSatisfiedInSt(anchorCaseIdx, st){
    const g = CASES[anchorCaseIdx] && CASES[anchorCaseIdx].fixedGlyph;
    if(g == null){
      return !!(st[anchorCaseIdx] && (st[anchorCaseIdx].typed || st[anchorCaseIdx].filled));
    }
    // chercher une occurrence de même glyphe posée
    for(let j=0;j<CASES.length;j++){
      if(CASES[j].fixedGlyph === g && st[j] && (st[j].typed || st[j].filled)) return true;
    }
    return false;
  }
  // Toutes les ancres obligatoires (non skipables, hors AS) de la chaîne d'une case sont-elles
  // satisfaites dans st ? Retourne la 1re ancre manquante {caseIdx, kind} ou null si tout est là.
  // Les niveaux SKIPABLES ne sont pas obligatoires -> ignorés (R14).
  function firstMissingAnchor(caseIdx, st){
    const chain = (CASES[caseIdx] && CASES[caseIdx].anchorChain) || [];
    for(const a of chain){
      if(a.kind === 'as') continue;
      if(a.caseIdx === caseIdx) continue;         // elle-même
      if(!isAnchorKind(a.kind)) continue;
      if(isSkippableKind(a.kind)) continue;       // skipable -> non obligatoire
      if(!anchorSatisfiedInSt(a.caseIdx, st)) return {caseIdx:a.caseIdx, kind:a.kind};
    }
    return null;
  }

  // L'ALIGNEUR. glyphs = recs chronologiques ; caseIds = caseId de chaque rec (null = clavier).
  // Produit st (agencement) + errors (divergences). Format identique à l'ancien validate.
  function alignStToFormula(glyphs, caseIds){
    caseIds = caseIds || [];
    const st = CASES.map(c => ({filled:false, glyph:c.fixedGlyph, typed:false, srcChar:-1, isUndef:false}));
    const errors = [];
    let cursor = -1;   // dernière case consommée dans la formule

    // Poser un glyphe dans une case (bloc interactif OU ancre fixe).
    function place(caseIdx, glyph, gi, undef){
      const c = CASES[caseIdx];
      if(isInteractive(c)){
        st[caseIdx].filled = true; st[caseIdx].glyph = glyph; st[caseIdx].srcChar = gi; st[caseIdx].isUndef = !!undef;
      } else {
        st[caseIdx].typed = true; st[caseIdx].srcChar = gi;
      }
    }
    // Marquer les ancres obligatoires SAUTÉES entre (from, to) exclus comme trous need_ (celles
    // qui devraient être posées mais ne le sont pas). Générique : lit la formule.
    function flagSkippedAnchors(fromCursor, toCase, gi){
      for(let k=fromCursor+1;k<toCase;k++){
        const c = CASES[k];
        if(!isAnchorKind(c.kind) || c.kind==='as') continue;
        if(isSkippableKind(c.kind)) continue;
        if(st[k].typed || st[k].filled) continue;
        // RÈGLE DU CARACTÈRE : si le glyphe de cette ancre est déjà posé ailleurs, elle est
        // satisfaite -> ne pas la réclamer.
        if(anchorSatisfiedInSt(k, st)) continue;
        // cette ancre obligatoire est sautée ET fait partie de la chaîne de toCase ?
        const chain = (CASES[toCase] && CASES[toCase].anchorChain) || [];
        const inChain = chain.some(a => a.caseIdx === k);
        if(inChain && !errors.some(e => e.target === k)){
          errors.push({at: gi, kind: needKindOfAnchor(c.kind), target: k});
        }
      }
    }
    // Chercher la prochaine case (en avant depuis cursor) qui accepte ce glyphe (SHEET) et dont
    // le kind correspond (FORMULE). Retourne {idx, undef} ou null. Le rec fait foi : on prend la
    // 1re occurrence libre en avant (l'ordre chronologique des recs garantit la bonne occurrence).
    function nextMatchingCase(glyph, gk){
      for(let j=cursor+1;j<CASES.length;j++){
        const c = CASES[j];
        // ancre fixe : matche si son glyphe == glyph
        // Case FIXE (non interactive, glyphe imposé) : matche par GLYPHE direct. Le fixedGlyph
        // EST l'identité de la case (posture, as, part/subpart fixe, ...). Le kind n'intervient
        // pas ici (une posture est classée 'descriptive dimension' au clavier mais sa case est
        // 'posture' : c'est le glyphe qui fait foi).
        if(!isInteractive(c)){
          if(c.fixedGlyph != null && c.fixedGlyph === glyph && !st[j].typed) return {idx:j, undef:false};
          continue;                            // ponctuation ou fixe non correspondante -> suivante
        }
        if(st[j].filled) continue;           // déjà remplie -> occurrence suivante
        // undefined accepté partout où l'option existe
        if(caseAcceptsAsUndef(j, glyph)) return {idx:j, undef:true};
        // kind du glyphe doit correspondre au kind de la case (FORMULE)
        if(gk !== c.kind) continue;
        // glyphe doit être une option de la case (SHEET)
        if(caseAccepts(j, glyph)) return {idx:j, undef:false};
      }
      return null;
    }

    for(let gi=0; gi<glyphs.length; gi++){
      const glyph = glyphs[gi];
      const gk = glyphKindGlobal(glyph);

      // R00b — POSTURE = 1re position uniquement. Prioritaire.
      if((gk==='posture' || gk==='descriptive dimension') && gi>0){
        errors.push({at:gi, kind:'wrong_kind', target:-1, expected:'posture', postureOutOfHead:true});
        continue;
      }

      // 1. REC AVEC caseId (glyphe de FORMULE) -> forcé sur SA case (R11, le rec fait foi).
      const forced = caseIds[gi];
      if(forced != null){
        let placed = false;
        for(let j=0;j<CASES.length;j++){
          if(CASES[j].dataOptions === forced && !st[j].filled){
            // vérifier l'ancrage amont : ancre manquante -> need_ (le glyphe reste posé, son rec le localise)
            const miss = firstMissingAnchor(j, st);
            if(miss){ errors.push({at:gi, kind:needKindOfAnchor(miss.kind), target:miss.caseIdx}); }
            // subvar de la value doit être là (R03) : si on cible une value dont la subvar amont manque
            const und = caseAcceptsAsUndef(j, glyph);
            place(j, glyph, gi, und);
            cursor = Math.max(cursor, j);
            placed = true; break;
          }
        }
        if(!placed){ errors.push({at:gi, kind:'no_match', target:-1}); }
        continue;
      }

      // CASCADE ref pos / zero : poser ref pos (ou zero) juste après une ANCRE (curseur sur une
      // ancre, quel que soit son niveau) remplit TOUS les blocs {subvar, value} de sa portée avec
      // les couples ref pos + zero linkés. Portée = règle du caractère (occurrences de même glyphe
      // traversées). Universel : lit la formule. Ne concerne que le CLAVIER (ref pos lié à zero).
      if((glyph===G_REFPOS || glyph===G_ZERO) && caseIds[gi]==null){
        const lc = cursor>=0 ? CASES[cursor] : null;
        if(lc && isAnchorKind(lc.kind)){
          const blocks = blocksUnderAnchorMod(cursor);
          if(blocks.length){
            let maxK = cursor;
            blocks.forEach(b => {
              if(b.sub!=null && !st[b.sub].filled){ st[b.sub].filled=true; st[b.sub].glyph=G_REFPOS; st[b.sub].srcChar=gi; if(b.sub>maxK)maxK=b.sub; }
              if(b.val!=null && !st[b.val].filled){ st[b.val].filled=true; st[b.val].glyph=G_ZERO;  st[b.val].srcChar=gi; if(b.val>maxK)maxK=b.val; }
            });
            cursor = Math.max(endOfAnchorScopeMod(cursor), maxK);
            continue;
          }
        }
      }

      // 2. REC SANS caseId (glyphe CLAVIER) -> chercher la prochaine case compatible EN AVANT.
      const cell = nextMatchingCase(glyph, gk);
      if(cell){
        // PRIORITÉ VALUE (R03/R02b) : une value réclame sa SUBVAR (cran juste au-dessus) AVANT
        // toute remontée d'ancrage. On est en bout de ligne : la seule façon de désambiguïser une
        // value est de remonter cran par cran (d'abord subvar, puis au-dessus si encore ambigu).
        // On ne réclame PAS encore les ancres sautées : la subvar est le 1er cran.
        if(CASES[cell.idx].kind==='value' && !cell.undef){
          const subIdx = cell.idx - 1;
          const subOK = CASES[subIdx] && CASES[subIdx].kind==='sub variable' && st[subIdx].filled && !st[subIdx].isUndef;
          if(CASES[subIdx] && CASES[subIdx].kind==='sub variable' && !subOK){
            let varIdx=-1;
            for(let q=subIdx-1;q>=0;q--){ const qk=CASES[q].kind; if(qk==='variable'){varIdx=q;break;} if(isAnchorKind(qk)||qk==='sub variable'){break;} }
            const varPosed = varIdx>=0 && st[varIdx].typed;
            const varSkippable = isSkippableKind('variable');
            let e;
            if(varPosed) e = {at:gi, kind:'need_subvar', target:subIdx};
            else if(varSkippable) e = {at:gi, kind:'need_var_or_subvar', target:subIdx, altTarget:varIdx};
            else e = {at:gi, kind:'need_var', target:(varIdx>=0?varIdx:subIdx)};
            if(!errors.some(x => x.target === e.target && x.kind === e.kind)) errors.push(e);
            continue; // value sauvage : on ne place pas ; la subvar est le 1er cran réclamé
          }
        }

        // ancres obligatoires sautées entre cursor et la cible -> trous need_ (seulement une fois
        // qu'on ne bloque plus sur la subvar).
        flagSkippedAnchors(cursor, cell.idx, gi);
        // colonne d'ancrage de la cible satisfaite ? sinon need_ + NE PAS placer (sauvage).
        const miss = firstMissingAnchor(cell.idx, st);
        if(miss){
          if(!errors.some(e => e.target === miss.caseIdx)){
            errors.push({at:gi, kind:needKindOfAnchor(miss.kind), target:miss.caseIdx});
          }
          continue;
        }
        place(cell.idx, glyph, gi, cell.undef);
        cursor = cell.idx;
        continue;
      }

      // 3. AUCUNE case compatible en avant -> le glyphe DIVERGE de la formule. Nature du refus :
      //    - une case de son kind existe en avant mais son ANCRE manque -> need_<ancre> (sauvage)
      //    - le glyphe est du mauvais kind ici -> wrong_kind
      //    - bon kind mais aucune case (mauvais membre / ordre) -> wrong_<kind>
      //    - rien d'identifiable -> no_match
      const refusal = classifyDivergence(glyph, gk, st, cursor, errors, gi);
      if(refusal) errors.push(refusal);
    }

    // POST-CONTRÔLES ÉMERGENTS (lus depuis la formule, pas des règles séparées) :
    // (a) R07 — variable posée puis quittée sans subvar définie -> need_subvar.
    postCheckVariableNeedsSubvar(glyphs, st, errors);
    // (b) R08b — ancre posée sans contenu puis quittée pour une ancre de niveau <= -> abandoned.
    postCheckAbandonedAnchor(st, errors);

    errors.sort((a,b)=> a.at - b.at);
    const first = errors.length ? errors[0] : null;
    return {
      st, errors,
      errorAt: first ? first.at : -1,
      errorKind: first ? first.kind : null,
      errorTarget: first ? first.target : -1
    };
  }

  // Classer une divergence (glyphe qui ne s'aligne sur aucune case en avant). Universel.
  function classifyDivergence(glyph, gk, st, cursor, errors, gi){
    if(gk === '?') return {at:gi, kind:'no_match', target:-1};
    // existe-t-il en avant une case de CE kind (dont le glyphe est option) mais dont l'ancre manque ?
    for(let j=cursor+1;j<CASES.length;j++){
      const c = CASES[j];
      if(c.kind !== gk) continue;
      if(!isInteractive(c) && c.fixedGlyph !== glyph) continue;
      if(isInteractive(c) && !caseAccepts(j, glyph)) continue;
      const miss = firstMissingAnchor(j, st);
      if(miss){
        if(!errors.some(e => e.target === miss.caseIdx)){
          return {at:gi, kind:needKindOfAnchor(miss.kind), target:miss.caseIdx};
        }
        return null; // déjà signalé
      }
    }
    // le kind est-il attendu quelque part en avant ? (mauvais membre) sinon mauvais niveau.
    const expectedKinds = new Set();
    for(let k=cursor+1;k<CASES.length;k++){
      const c=CASES[k];
      if(isAnchorKind(c.kind)) expectedKinds.add(c.kind);
      else if(isInteractive(c) && !st[k].filled) expectedKinds.add(c.kind);
    }
    if(expectedKinds.has(gk)){
      return {at:gi, kind: wrongKindGlobal(gk), target:-1, expected:gk};
    }
    return {at:gi, kind:'wrong_kind', target:-1, expected:[...expectedKinds][0]||null, got:gk};
  }
  function wrongKindGlobal(kind){
    switch(kind){
      case 'selection':     return 'wrong_selection';
      case 'part':          return 'wrong_part';
      case 'sub part':      return 'wrong_subpart';
      case 'subselection':  return 'wrong_subselection';
      case 'variable':      return 'wrong_var';
      case 'sub variable':  return 'wrong_subvar';
      case 'value':         return 'wrong_value';
      default:              return 'no_match';
    }
  }
  // R07 — une variable posée (typed) exige une subvar définie SI un glyphe a été tapé après elle.
  function postCheckVariableNeedsSubvar(glyphs, st, errors){
    for(let vi=0; vi<CASES.length; vi++){
      if(CASES[vi].kind !== 'variable') continue;
      if(!st[vi].typed) continue;
      let subIdx = -1;
      for(let k=vi+1;k<CASES.length;k++){
        const kk = CASES[k].kind;
        if(kk === 'sub variable' && isInteractive(CASES[k])){ subIdx = k; break; }
        if(kk === 'variable' || isAnchorKind(kk)) break;
      }
      if(subIdx < 0) continue;
      if(st[subIdx].filled && !st[subIdx].isUndef) continue;
      const varSrc = st[vi].srcChar;
      if(varSrc < 0) continue;
      let somethingAfter = false;
      for(let k=0;k<CASES.length;k++){
        if((st[k].filled || st[k].typed) && st[k].srcChar > varSrc){ somethingAfter = true; break; }
      }
      if(st[subIdx].isUndef && st[subIdx].srcChar >= 0) somethingAfter = true;
      if(!somethingAfter) continue;
      if(!errors.some(e => e.target === subIdx)){
        errors.push({at: varSrc, kind: 'need_subvar', target: subIdx});
      }
    }
  }
  // R08b — ancre posée sans contenu, quittée pour une ancre de niveau <= -> abandoned.
  function postCheckAbandonedAnchor(st, errors){
    for(let ai=0; ai<CASES.length; ai++){
      if(!isAnchorKind(CASES[ai].kind) || CASES[ai].kind==='as') continue;
      if(!st[ai].typed) continue;
      const La = anchorDepthOf(ai);
      const srcA = st[ai].srcChar;
      if(srcA < 0) continue;
      if(subtreeHasFilledBlock(ai, st)) continue;
      let deviated = false;
      for(let k=0;k<CASES.length;k++){
        if(k===ai) continue;
        if(!isAnchorKind(CASES[k].kind) || CASES[k].kind==='as') continue;
        if(!st[k].typed || st[k].srcChar < 0) continue;
        if(st[k].srcChar > srcA && anchorDepthOf(k) <= La){ deviated = true; break; }
      }
      if(deviated && !errors.some(e => e.target === ai)){
        errors.push({at: srcA, kind: needKindOfAnchor(CASES[ai].kind), target: ai, abandoned: true});
      }
    }
  }

  // validate DÉLÈGUE désormais à l'aligneur st↔formule (moteur de vérité universel). L'ancien
  // corps procédural (findForward glouton + règles éparses) est conservé sous validateLegacy à
  // des fins de comparaison/rollback, mais n'est plus appelé.
  function validate(glyphs, caseIds){
    return alignStToFormula(glyphs, caseIds);
  }
  function validateLegacy(glyphs, caseIds){
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
        if(isAnchorKind(CASES[k].kind))return -1; // sortie du bloc : toute ancre borne
      } return -1;
    }
    function pairedSubOf(valIdx){
      for(let k=valIdx-1;k>=0;k--){
        if(CASES[k].kind==='sub variable'&&isInteractive(CASES[k]))return k;
        if(CASES[k].kind==='value')return -1;
      } return -1;
    }
    function partName(i){ const m=CASES[i].title.split(':'); return m.length>1?m[1].trim():CASES[i].title.trim(); }
    // Profondeur d'imbrication d'une case ANCRE = position dans sa chaîne (= longueur de sa
    // anchorChain, l'ancre incluse). Non-ancre -> 0. Sur cette page, un même kind peut avoir des
    // profondeurs différentes selon la branche : on lit donc la profondeur RÉELLE de la case,
    // jamais un barème kind->niveau (qui serait ambigu, cf upperface selection sous part OU sous
    // rien selon eyeball/eyelids).
    function depthAt(i){
      const c = CASES[i];
      if(!c || !isAnchorKind(c.kind)) return 0;
      return c.anchorChain ? c.anchorChain.length : 0;
    }
    function anchorLevelAt(i){ return depthAt(i); }
    // Frontière de portée d'une ancre (case anchorIdx), avec la règle du CARACTÈRE :
    //  - une ancre de niveau STRICTEMENT plus haut (depth < L) : on est sorti vers le haut -> break.
    //  - une ancre de MÊME niveau (depth == L) : break SEULEMENT si son caractère DIFFÈRE de
    //    l'ancre de départ. Même caractère = même ancre fragmentée (ex lips répété par subpart)
    //    -> on TRAVERSE. Caractère différent (ex jaw) = autre ancre -> break.
    //  - une ancre plus BASSE (depth > L) : sous-arborescence -> on continue.
    // La ponctuation est neutre. Tout est anchor level + comparaison de glyphe au même niveau.
    function isScopeBoundary(anchorIdx, k, L){
      if(!isAnchorKind(CASES[k].kind)) return false;
      const dk = depthAt(k);
      if(dk < L) return true;                       // remonté au-dessus -> frontière
      if(dk === L){                                 // même niveau : dépend du caractère
        const gStart = CASES[anchorIdx].fixedGlyph;
        const gHere  = CASES[k].fixedGlyph;
        return gHere !== gStart;                    // caractère différent -> frontière ; même -> traverse
      }
      return false;                                 // plus bas -> dans la sous-arborescence
    }
    function blocksUnderAnchor(anchorIdx){
      const L=depthAt(anchorIdx);
      if(L===0) return [];
      const blocks=[];
      for(let k=anchorIdx+1;k<CASES.length;k++){
        if(isScopeBoundary(anchorIdx, k, L)) break;
        const ck=CASES[k].kind;
        if(ck==='sub variable'&&isInteractive(CASES[k])) blocks.push({sub:k,val:null});
        if(ck==='value'&&isInteractive(CASES[k])&&blocks.length){
          const last=blocks[blocks.length-1];
          if(last.val==null) last.val=k;
        }
      }
      return blocks;
    }
    // Dernière case de la portée d'une ancre (même frontière que blocksUnderAnchor).
    function endOfAnchorScope(anchorIdx){
      const L=depthAt(anchorIdx);
      let last=anchorIdx;
      for(let k=anchorIdx+1;k<CASES.length;k++){
        if(isScopeBoundary(anchorIdx, k, L)) break;
        last=k;
      }
      return last;
    }
    function cascadeFill(blocks, gi){
      const f=[];
      blocks.forEach(b=>{
        if(b.sub!=null&&!st[b.sub].filled){st[b.sub].filled=true;st[b.sub].glyph=G_REFPOS;st[b.sub].srcChar=gi;f.push(b.sub);}
        if(b.val!=null&&!st[b.val].filled){st[b.val].filled=true;st[b.val].glyph=G_ZERO;st[b.val].srcChar=gi;f.push(b.val);}
      });
      return f;
    }
    // R02 — Classification d'un REFUS. Quand un glyphe ne matche aucune case en avant, on
    // précise POURQUOI, par priorité (wrong_kind > wrong_<niveau> > no_match) :
    //  - le glyphe est d'un KIND identifiable (via glyphKindLocal) présent dans la formule à un
    //    autre endroit, mais pas au niveau attendu ici -> `wrong_kind` (mauvais niveau).
    //  - le glyphe est du BON kind attendu, mais aucune case de ce kind ne l'accepte en avant
    //    (mauvais membre) -> `wrong_<niveau>` (wrong_part, wrong_subvar, ...).
    //  - le glyphe n'est d'aucun kind identifiable de la page -> `no_match`.
    // « niveau attendu » = les kinds des cases accessibles en avant depuis le curseur (les cases
    // interactives non remplies + ancres, jusqu'à la fin). Universel : lu depuis CASES/st.
    function wrongKindOf(kind){
      switch(kind){
        case 'selection':     return 'wrong_selection';
        case 'part':          return 'wrong_part';
        case 'sub part':      return 'wrong_subpart';
        case 'subselection':  return 'wrong_subselection';
        case 'variable':      return 'wrong_var';
        case 'sub variable':  return 'wrong_subvar';
        case 'value':         return 'wrong_value';
        default:              return 'no_match';
      }
    }
    function classifyRefusal(glyph){
      const gk = glyphKindLocal(glyph);
      if(gk === '?' ) return {err:'no_match'};              // aucun kind identifiable
      // kinds attendus en avant (cases non remplies accessibles depuis le curseur)
      const expectedKinds = new Set();
      for(let k=cursor+1;k<CASES.length;k++){
        const c=CASES[k];
        if(isAnchorKind(c.kind)) expectedKinds.add(c.kind);
        else if(isInteractive(c) && !st[k].filled) expectedKinds.add(c.kind);
      }
      // le glyphe est-il du bon kind attendu mais aucune case précise ne l'accepte ? (mauvais membre)
      if(expectedKinds.has(gk)) return {err: wrongKindOf(gk), expected: gk};
      // le glyphe est d'un kind connu de la page mais PAS attendu ici -> mauvais niveau
      return {err:'wrong_kind', expected:[...expectedKinds][0] || null, got: gk};
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

      // R01b — Manque d'ancrage GÉNÉRIQUE (multi-niveaux, lu depuis anchorChain).
      // Pour une case cible j, on remonte sa chaîne d'ancres (du sommet vers le bas). Le premier
      // maillon ancrant dont l'ancre N'EST PAS posée dans l'agencement (st) = le niveau manquant.
      // On émet need_<kind> de ce maillon. Remplace les drapeaux figés cuP/cuSP (part/subpart).
      // "Ancre posée" : la case-ancre est fixe et déjà passée (typée), OU interactive et remplie.
      function anchorPosed(anchorCaseIdx){
        const ac = CASES[anchorCaseIdx];
        if(!ac) return false;
        if(isInteractive(ac)) return st[anchorCaseIdx] && st[anchorCaseIdx].filled;
        // ancre fixe : posée si un glyphe l'a franchie (typed) OU si un contenu de sa portée
        // a été saisi avant le curseur courant (l'ancre fixe est implicitement validée).
        if(st[anchorCaseIdx] && (st[anchorCaseIdx].typed || anchorCaseIdx <= cursor)) return true;
        // RÈGLE DU CARACTÈRE : une ancre fixe peut être RÉPÉTÉE (même glyphe, occurrences
        // multiples : ex nose apparaît avant nostrils ET avant dorsum). Ces occurrences sont la
        // MÊME ancre fragmentée. Poser une occurrence satisfait l'ancrage de toutes. Donc l'ancre
        // est posée si une autre case de MÊME glyphe (et même niveau) est typée.
        const gA = ac.fixedGlyph, dA = anchorDepthOf(anchorCaseIdx);
        if(gA){
          for(let k=0;k<CASES.length;k++){
            if(k===anchorCaseIdx) continue;
            const ck=CASES[k];
            if(ck.fixedGlyph===gA && anchorDepthOf(k)===dA && st[k] && st[k].typed) return true;
          }
        }
        return false;
      }
      function needKindOf(anchorKind){ return needKindOfAnchor(anchorKind); }
      // Niveau manquant le PLUS PROCHE de la case (on remonte d'UN cran, pas jusqu'au sommet).
      // On parcourt la chaîne du BAS (le plus profond, juste au-dessus de j) vers le HAUT et on
      // retourne le premier maillon ancrant non posé et non skipable. Ex : subselection tapée
      // seule -> on demande la subpart (cran juste au-dessus), pas la part (sommet).
      function missingAnchorFor(j){
        const chain = CASES[j] ? CASES[j].anchorChain : [];
        // du plus profond au plus haut
        for(let idx = chain.length - 1; idx >= 0; idx--){
          const link = chain[idx];
          if(link.kind === 'as') continue;               // AS = racine, jamais un manque
          if(!isAnchorKind(link.kind)) continue;
          if(link.caseIdx === j) continue;               // j lui-même n'est pas son propre parent
          if(isSkippableKind(link.kind)) continue;        // niveau SKIPABLE : jamais réclamé
          if(!anchorPosed(link.caseIdx)){
            return { kind: needKindOf(link.kind), caseIdx: link.caseIdx };
          }
        }
        return null;
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
            // le glyphe est une value mais pas celle de cette case -> wrong_value (bon niveau,
            // mauvais membre). R02 : bad_value scindé.
            if(glyphKindLocal(glyph)==='value'){ return{err:"wrong_value", target:j, expected:'value'}; }
            return{err:'value_due', target:j};
          }
          // subvar UNDEFINED (ou vide) + vraie value -> il manque le niveau var/subvar.
          // R02b : le KIND du manque dépend de la variable au-dessus (skipable ? posée ?).
          if((subFilledUndef || (ps&&ps.kind==='sub variable'&&!st[j-1].filled))){
            if(gMatch(glyph,j)){
              // trouver la variable de ce bloc (juste avant la subvar j-1)
              let varIdx=-1;
              for(let q=j-2;q>=0;q--){ const qk=CASES[q].kind; if(qk==='variable'){varIdx=q;break;} if(isAnchorKind(qk)||qk==='sub variable'){break;} }
              const varPosed = varIdx>=0 && st[varIdx].typed;
              const varSkippable = isSkippableKind('variable');
              if(varPosed){
                return{err:'need_subvar', target:j-1};             // var déjà là : manque que la subvar
              } else if(varSkippable){
                // var skipable non posée : deux chemins (var puis subvar, OU subvar directe).
                // Cibles multiples : la subvar (j-1) ET la variable (varIdx).
                return{err:'need_var_or_subvar', target:j-1, altTarget:varIdx};
              } else {
                return{err:'need_var', target:(varIdx>=0?varIdx:j-1)}; // var obligatoire
              }
            }
          }
        }
        // UNDEFINED en subvar libre : accepté (contenu neutre)
        if(c.kind==='sub variable'&&isInteractive(c)&&!st[j].filled&&isUndefGlyph(glyph,j)){
          return{idx:j, undef:true};
        }
        if(gMatch(glyph,j)){
          // R13 — Doublon GÉNÉRIQUE sur ré-invocation d'un niveau ancrant (toute la chaîne).
          // Ré-invoquer une ancre déjà présente n'est pas fautif si elle ouvre un sous-niveau
          // encore vierge ; c'est fautif si le sous-niveau visé est déjà annoté (une subvar y
          // est posée). Générique : vaut pour n'importe quel niveau ancrant, pas que la part.
          if(isAnchorKind(c.kind)){
            const dup = anchorReInvocationDuplicate(j);
            if(dup) return{err:'no_match'};
          }
          // Manque d'ancrage (multi-niveaux) : si la chaîne de j a un maillon ancrant non posé,
          // c'est ce niveau qui manque. missingAnchorFor lit la chaîne réelle de j : si la case
          // n'a aucune ancre parente manquante (ou aucune chaîne), il retourne null -> pas d'erreur.
          // Aucun niveau nommé : la chaîne d'ancrage décide.
          const miss = missingAnchorFor(j);
          if(miss && miss.caseIdx !== j){   // j lui-même n'est pas "son propre manque"
            return{err:miss.kind, target:miss.caseIdx};
          }
          return{idx:j};
        }
      }
      return classifyRefusal(glyph);   // R02 : préciser wrong_kind / wrong_<niveau> / no_match
    }

    // R13 — une ré-invocation d'ancre (case j, ancre matchée) est-elle un doublon fautif ?
    // Vrai si TOUS les sous-niveaux ancrants immédiats sous j sont déjà annotés (saturation),
    // ou si le sous-niveau que cette ré-invocation ouvre est déjà annoté. "Annoté" = une subvar
    // est posée dans sa portée. Générique sur la chaîne.
    function anchorReInvocationDuplicate(j){
      const Lj = depthAt(j);
      // portée de j = jusqu'à la prochaine ancre de niveau <= Lj (ou fin). Ponctuation neutre.
      let end = CASES.length;
      for(let k=j+1;k<CASES.length;k++){
        const ck=CASES[k].kind;
        if(isAnchorKind(ck) && depthAt(k)<=Lj){ end=k; break; }
      }
      // sous-niveaux ancrants IMMÉDIATS (profondeur exactement Lj+1) dans la portée
      const subAnchors=[];
      for(let k=j+1;k<end;k++){
        if(isAnchorKind(CASES[k].kind) && depthAt(k) === Lj+1){
          subAnchors.push(k);
        }
      }
      const annotatedInScope = (a, b) => {
        for(let k=a;k<b;k++){ if(CASES[k].kind==='sub variable' && isInteractive(CASES[k]) && st[k].filled) return true; }
        return false;
      };
      if(subAnchors.length===0){
        // pas de sous-niveau : doublon si la portée est déjà annotée
        return annotatedInScope(j+1, end);
      }
      // saturation : tous les sous-niveaux annotés -> doublon d'emblée
      let allAnnotated = true;
      for(let s=0;s<subAnchors.length;s++){
        const start=subAnchors[s];
        const stop = (s+1<subAnchors.length) ? subAnchors[s+1] : end;
        if(!annotatedInScope(start, stop)){ allAnnotated=false; }
      }
      return allAnnotated;
    }

    // rejouer
    let retryCount = 0;
    for(let gi=0; gi<glyphs.length; gi++){
      const glyph=glyphs[gi];

      // R00b — POSTURE = premier glyphe uniquement (cadre prioritaire). Une posture ailleurs
      // qu'en tête de saisie est une erreur ; prime sur les autres règles. En gi=0 elle est
      // légitime (elle s'ancre sur la case posture @0 via le flux normal). La posture peut être
      // classée 'posture' ou 'descriptive dimension' selon la source (titre vs clavier).
      const gk0 = glyphKindLocal(glyph);
      if((gk0==='posture' || gk0==='descriptive dimension') && gi>0){
        errors.push({at:gi, kind:'wrong_kind', target:-1, expected:'posture', postureOutOfHead:true});
        continue;
      }

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
        // GÉNÉRIQUE : poser ref pos/zero juste après une ANCRE (quel que soit son niveau :
        // selection/AS, part, sub part, subselection) remplit tous les blocs de SA PORTÉE avec
        // les couples ref pos + zero linkés. La portée et sa fin se déduisent du niveau d'ancre.
        // NB : dépend d'un anchorChain correct (livré par la passe SYNTAXE). Tant que la chaîne
        // reste sur le barème finger, cette cascade ne sera juste que sur finger. Voulu : on
        // branche l'universel maintenant, il se corrige dès que la syntaxe livre la vraie chaîne.
        if(lc&&isAnchorKind(lc.kind)){
          const blocks=blocksUnderAnchor(cursor);
          if(blocks.length){
            const f=cascadeFill(blocks, gi);
            const mx=Math.max.apply(null,f);
            cursor=Math.max(endOfAnchorScope(cursor), mx);
            continue;
          }
        }
      }

      const res=findForward(glyph, caseIds[gi]);
      if(res.err){
        // MULTI-ERREUR : enregistrer l'erreur et CONTINUER (skip du glyph fautif).
        errors.push({at:gi, kind:res.err, target:(res.target!=null?res.target:-1),
                     altTarget:(res.altTarget!=null?res.altTarget:undefined),
                     expected:res.expected});
        // Avancer le curseur pour que le prochain glyph soit correctement ciblé :
        // pour une value orpheline (need_subvar), on marque la value visée comme
        // "occupée" par ce glyph et on avance au-delà, afin que la value suivante
        // cherche dans un bloc ultérieur.
        if((res.err === 'need_subvar' || res.err === 'need_var_or_subvar' || res.err === 'need_var') && res.target != null){
          // RÈGLE DU GLYPHE SAUVAGE : un glyphe tapé au CLAVIER (sans caseId) qui n'a pas de
          // contexte valide ne se place NULLE PART. On émet juste le manque (le cran au-dessus :
          // subvar, var-ou-subvar, ou var selon R02b) ; l'UI proposera en bleu les cases
          // possibles. On NE marque PAS la value. Un glyphe de FORMULE porte un caseId : son rec
          // sait où il habite, il n'arrive jamais ici sans contexte -> placement provisoire.
          const fromKeyboard = (caseIds[gi] == null);
          if(!fromKeyboard){
            const valCase = res.target + 1;
            if(CASES[valCase] && CASES[valCase].kind === 'value'){
              st[valCase].filled = true; st[valCase].glyph = glyph; st[valCase].srcChar = gi;
              cursor = valCase;
            }
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
    // RÈGLE : une VARIABLE activée par l'utilisateur (typed) exige une subvar DÉFINIE,
    // MAIS seulement si l'utilisateur a tapé AUTRE CHOSE après la variable (il a "quitté"
    // le bloc sans définir sa subvar). Si la variable est le dernier glyphe saisi, on attend
    // (pas d'erreur : la subvar peut encore arriver).
    // Satisfait par : une vraie subvar OU ref pos. PAS undefined ni l'absence.
    for(let vi=0; vi<CASES.length; vi++){
      if(CASES[vi].kind !== 'variable') continue;
      if(!st[vi].typed) continue; // variable non tapée -> pas d'exigence
      // subvar de ce bloc = prochaine case 'sub variable' interactive
      let subIdx = -1;
      for(let k=vi+1; k<CASES.length; k++){
        const kk = CASES[k].kind;
        if(kk === 'sub variable' && isInteractive(CASES[k])){ subIdx = k; break; }
        if(kk === 'variable' || isAnchorKind(kk)) break; // sortie du bloc (ponctuation neutre)
      }
      if(subIdx < 0) continue;
      const sfilled = st[subIdx].filled;
      const sundef  = st[subIdx].isUndef;
      if(sfilled && !sundef) continue; // subvar bien définie -> OK

      // subvar absente ou undefined : erreur SEULEMENT si un glyphe a été tapé APRÈS la variable.
      // On regarde s'il existe un srcChar (glyphe saisi) postérieur à celui de la variable.
      const varSrc = st[vi].srcChar;
      if(varSrc < 0) continue;
      let somethingAfter = false;
      for(let k=0;k<CASES.length;k++){
        if((st[k].filled || st[k].typed) && st[k].srcChar > varSrc){ somethingAfter = true; break; }
      }
      // (si la subvar elle-même est remplie en undefined, c'est déjà "autre chose" de tapé)
      if(sundef && st[subIdx].srcChar >= 0) somethingAfter = true;
      if(!somethingAfter) continue; // variable en fin de saisie -> on attend, pas d'erreur

      const already = errors.some(e => e.target === subIdx);
      if(!already){
        errors.push({at: varSrc, kind: 'need_subvar', target: subIdx});
      }
    }
    // R08b — COMPLÉTUDE DE BRANCHE (ancre abandonnée). Une branche entamée doit être menée au
    // bout sans déviation : dès qu'une ancre A est posée puis QUITTÉE pour une ancre B de niveau
    // <= celui de A (même niveau ou plus haut) SANS que A ait reçu de contenu (aucune subvar
    // posée dans sa portée), A est abandonnée -> erreur LOCALE sur A. « Annoté » = une subvar
    // posée (R13 : la subvar est le plancher ; var au-dessus et value en-dessous skippables).
    // Générique : vaut pour tout niveau ancrant. Universel via anchorDepthOf + subtreeHasFilledBlock.
    for(let ai=0; ai<CASES.length; ai++){
      if(!isAnchorKind(CASES[ai].kind) || CASES[ai].kind==='as') continue;
      if(!st[ai].typed) continue;                          // ancre non posée -> rien à juger
      const La = anchorDepthOf(ai);
      const srcA = st[ai].srcChar;
      if(srcA < 0) continue;
      // A a-t-elle du contenu (une subvar posée) dans sa portée ? (règle du caractère incluse)
      if(subtreeHasFilledBlock(ai, st)) continue;          // A alimentée -> pas abandonnée
      // A est vide : a-t-on posé APRÈS A une ancre de niveau <= La (déviation hors de A) ?
      let deviated = false;
      for(let k=0;k<CASES.length;k++){
        if(k===ai) continue;
        if(!isAnchorKind(CASES[k].kind) || CASES[k].kind==='as') continue;
        if(!st[k].typed || st[k].srcChar < 0) continue;
        if(st[k].srcChar > srcA && anchorDepthOf(k) <= La){ deviated = true; break; }
      }
      if(deviated && !errors.some(e => e.target === ai)){
        errors.push({at: srcA, kind: needKindOfAnchor(CASES[ai].kind), target: ai, abandoned: true});
      }
    }
    // re-trier les erreurs par ordre de saisie (at croissant) pour cohérence
    errors.sort((a,b)=> a.at - b.at);
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
      const subResult = {st:st, errorAt:e.at, errorKind:e.kind, errorTarget:e.target, altTarget:e.altTarget, abandoned:e.abandoned, _glyphs:glyphs};
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

  function partNameOf(i){ const m=CASES[i].title.split(':'); return m.length>1?m[1].trim():CASES[i].title.trim(); }

  // ---- Candidats multiples GÉNÉRIQUES (tout niveau ancrant) ----
  // Table : kind ancrant -> liste des glyphes fixes de ce kind présents dans la formule
  // (ex tous les glyphes 'part', tous les 'sub part', 'selection', 'subselection').
  // Remplace PART_GLYPHS/SUBPART_GLYPHS (finger-dur). Sert à énumérer les candidats à tester.
  const ANCHOR_GLYPHS_BY_KIND = (function(){
    const t = {}; // kind -> Set(glyph)
    CASES.forEach(c => {
      if(isAnchorKind(c.kind) && c.fixedGlyph){
        (t[c.kind]||(t[c.kind]=new Set())).add(c.fixedGlyph);
      }
    });
    // Set -> Array
    const out={}; Object.keys(t).forEach(k=>out[k]=Array.from(t[k])); return out;
  })();

  // kind d'un glyph, déduit des cases (fixe ou option interactive).
  function glyphKind(g){
    for(const c of CASES){ if(c.fixedGlyph===g) return c.kind; }
    for(const c of CASES){
      if(isInteractive(c)){
        const opts = GROUPS[c.dataOptions]||[];
        if(opts.some(o=>o.glyph===g && o.label!=='undefined')) return c.kind;
      }
    }
    return '?';
  }

  // kind ancrant réclamé par un kind d'erreur need_*.
  function anchorKindOfNeed(needKind){
    switch(needKind){
      case 'need_selection':    return 'selection';
      case 'need_part':         return 'part';
      case 'need_subpart':      return 'sub part';
      case 'need_subselection': return 'subselection';
      default:                  return null;
    }
  }

  // Une case-ancre `ci` a-t-elle déjà du contenu annoté dans sa portée ? (pour exclure les
  // ancres déjà remplies des candidats). "Contenu" = une subvar interactive remplie dans la
  // sous-arborescence de ci (jusqu'à la prochaine ancre de profondeur <= celle de ci).
  function anchorCellHasContent(ci, result){
    const depthOf = (i)=>{ const c=CASES[i]; return (c && isAnchorKind(c.kind) && c.anchorChain) ? c.anchorChain.length : 0; };
    const L = depthOf(ci);
    for(let k=ci+1;k<CASES.length;k++){
      const ck=CASES[k].kind;
      if(isAnchorKind(ck) && depthOf(k)<=L) break; // seule borne : anchor level <= L
      if(isInteractive(CASES[k]) && CASES[k].kind==='sub variable' && result.st[k].filled) return true;
    }
    return false;
  }

  // Trouve les cases candidates (à colorer bleu) pour un manque d'ancrage à choix multiple.
  // GÉNÉRIQUE : vaut pour need_selection / need_part / need_subpart / need_subselection.
  // Critère robuste (déjà en prod) : une ancre n'est candidate que si INSÉRER son glyphe juste
  // avant le glyphe orphelin réduit réellement le nombre d'erreurs. Cela écarte automatiquement
  // les ancres qui n'accueillent pas le type du glyphe orphelin (P03 jaw : une part sans subpart
  // ne produira jamais de candidat subpart, car aucune subpart n'existe pour elle).
  function findCandidateCells(glyphs, result){
    const kind = result.errorKind;
    const at = result.errorAt;
    if(at < 0) return [];
    const anchorKind = anchorKindOfNeed(kind);
    if(!anchorKind) return null; // erreur non ambiguë (value_due, need_subvar, wrong_*, no_match)

    const glyphList = ANCHOR_GLYPHS_BY_KIND[anchorKind] || [];
    if(!glyphList.length) return null; // aucune ancre de ce kind sur la page -> pas de candidats

    const baseErr = (validate(glyphs).errors || []).length;
    const cells = [];
    for(const ag of glyphList){
      const test = glyphs.slice(0, at).concat([ag], glyphs.slice(at));
      const nErr = (validate(test).errors || []).length;
      if(nErr < baseErr){
        // trouver la/les case(s) de ce glyphe-ancre dont le bloc est encore libre
        for(let i=0;i<CASES.length;i++){
          if(CASES[i].kind===anchorKind && CASES[i].fixedGlyph===ag){
            if(!anchorCellHasContent(i, result)){ cells.push(i); break; } // 1re case libre de cette ancre
          }
        }
      }
    }
    return cells;
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
    let cellToMark = -1;
    let isHole = false;  // trou (manque) -> bleu ; sinon rouge
    // Manques d'ancrage et de bloc : la case à marquer EST errorTarget (missingAnchorFor et la
    // détection posent déjà la caseIdx de l'ancre/bloc manquant). Générique, aucun niveau nommé.
    const HOLE_KINDS = ['need_subvar','value_due','need_selection','need_part','need_subpart',
                        'need_subselection','need_var','need_var_or_subvar'];
    // R08b : une ancre ABANDONNÉE (posée sans contenu, quittée) est une FAUTE -> rouge, pas un
    // trou. Bien que le kind soit un need_*, le flag abandoned la classe en faute.
    if(result.abandoned){
      cellToMark = errorTarget; isHole = false;
    }
    else if(errorKind === 'need_var_or_subvar'){
      // R02b : deux cibles proposées (subvar ET variable) -> les deux en bleu.
      if(errorTarget>=0 && CASES[errorTarget].span) CASES[errorTarget].span.classList.add('solcell');
      if(result.altTarget!=null && result.altTarget>=0 && CASES[result.altTarget].span) CASES[result.altTarget].span.classList.add('solcell');
      return;
    }
    else if(HOLE_KINDS.includes(errorKind)){
      cellToMark = errorTarget; isHole = true;
    }
    else { cellToMark = errorTarget; }  // no_match / wrong_* -> rouge (faute)
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
    const anchorKindRepair = anchorKindOfNeed(kind); // selection/part/sub part/subselection ou null
    if(anchorKindRepair){
      // réinsérer une ancre du bon kind qui rend la séquence valide (1er candidat réparateur).
      // Générique : vaut pour tout niveau ancrant (plus de mémorisation finger par nom de doigt).
      const glyphList = ANCHOR_GLYPHS_BY_KIND[anchorKindRepair] || [];
      for(const ag of glyphList){
        const test = glyphs.slice(0,at).concat([ag], glyphs.slice(at));
        if(validate(test).errorAt < 0){ repairGlyph = ag; break; }
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
        // fin du bloc : nouvelle sub variable OU toute ancre (ponctuation neutre, ignorée)
        if(kind==='sub variable' || isAnchorKind(kind)) break;
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
  // URLs des SVG du ◌ : forme (round=structurel / square=valeur) × couleur (red=manque /
  // blue=résolution active). Le rendu injecte un <img> et choisit rouge/bleu selon l'état.
  const DOT_SVG_URLS = {
    round: { red:  'https://cdn.prod.website-files.com/6a4872338398df20e02f9834/6a4a77ac70325ae14aca4600_round-dots_red.svg',
             blue: 'https://cdn.prod.website-files.com/6a4872338398df20e02f9834/6a4a77acf238973d23467c90_round-dots_blue.svg' },
    square:{ red:  'https://cdn.prod.website-files.com/6a4872338398df20e02f9834/6a4a77ac65c0cac5cff9a5ca_square-dots_red.svg',
             blue: 'https://cdn.prod.website-files.com/6a4872338398df20e02f9834/6a4a77ac2a6dee9e17e6f0f8_square-dots_blue.svg' }
  };
  function toGlyphs(str){
    // la validation IGNORE les ◌ (ce ne sont pas de vrais glyphes)
    return Array.from(str).filter(ch => ch !== DOT);
  }

  // ---------- ÉVÉNEMENT PRINCIPAL : tout changement de l'input ----------
  let mirrorEl = document.getElementById('input-mirror');
  // Le conteneur #input-mirror n'est pas garanti présent dans le DOM Webflow (il n'est déclaré
  // qu'en CSS). getMirror() le récupère, et le CRÉE s'il manque (inséré à côté du champ input),
  // pour que l'affichage coloré du champ fonctionne sur toutes les pages. Si même le champ input
  // est absent, retourne un objet INERTE (no-op) : le moteur reste fonctionnel sans planter.
  const INERT_MIRROR = { innerHTML:'', scrollLeft:0, appendChild(){}, querySelector(){return null;}, querySelectorAll(){return [];} };
  function getMirror(){
    if(mirrorEl) return mirrorEl;
    mirrorEl = document.getElementById('input-mirror');
    if(mirrorEl) return mirrorEl;
    // créer le conteneur mirror s'il n'existe pas
    if(inputEl && inputEl.parentNode){
      const mm = document.createElement('div');
      mm.id = 'input-mirror';
      mm.setAttribute('aria-hidden','true');
      inputEl.parentNode.insertBefore(mm, inputEl.nextSibling);
      mirrorEl = mm;
      return mirrorEl;
    }
    return INERT_MIRROR;
  }
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

  // RÉCONCILIATION — enquête de contexte (D14).
  //
  // Tout geste natif (clavier physique, collage, coupe, drag, menu contextuel) ne touche QUE le
  // champ. À cet instant les recs ignorent le changement : le champ est le seul CAPTEUR du
  // geste — jamais la référence. On lit ce qui a changé dans le champ et on le traduit en
  // MUTATION des recs, en PRÉSERVANT les recs (donc leur id + leur caseId) qui n'ont pas bougé.
  //
  // Principe : on ne réconcilie PAS glyphe par glyphe. Une action utilisateur = un LOT de
  // glyphes contigus. On identifie le bloc de recs qui matche ce lot via la SIGNATURE DE
  // CONTEXTE (voisinage du lot), en élargissant le rayon jusqu'à lever l'ambiguïté.
  //
  // fieldSnapshotBefore : séquence de glyphes du champ AVANT le geste (maintenue à jour à
  // chaque recalcul). MODEL est réputé cohérent avec elle en entrée.
  let fieldSnapshotBefore = [];

  // Plus longue sous-séquence commune (indices) entre deux séquences de glyphes.
  // Retourne la liste des couples [ai, bi] des positions APPARIÉES (le "socle" inchangé).
  function lcsPairs(a, b){
    const n = a.length, m = b.length;
    const dp = Array.from({length:n+1}, () => new Int32Array(m+1));
    for(let i=n-1;i>=0;i--){
      for(let j=m-1;j>=0;j--){
        dp[i][j] = (a[i]===b[j]) ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j], dp[i][j+1]);
      }
    }
    const pairs = [];
    let i=0, j=0;
    while(i<n && j<m){
      if(a[i]===b[j]){ pairs.push([i,j]); i++; j++; }
      else if(dp[i+1][j] >= dp[i][j+1]) i++;
      else j++;
    }
    return pairs;
  }

  // Signature de contexte d'une position dans une séquence : les glyphes à gauche et à droite
  // jusqu'à un rayon donné (bornes du tableau comprises comme marqueurs).
  function contextSig(seq, pos, radius){
    const L = [], R = [];
    for(let r=1;r<=radius;r++){ L.push(pos-r>=0 ? seq[pos-r] : '\u0000^'); }
    for(let r=1;r<=radius;r++){ R.push(pos+r<seq.length ? seq[pos+r] : '\u0000$'); }
    return L.reverse().join('') + '|' + R.join('');
  }

  function modelReconcileWithField(){
    const field = Array.from(inputEl.value).filter(ch => ch !== DOT);
    const before = fieldSnapshotBefore;

    // Aligné avec l'état capté avant le geste ET modèle cohérent : rien à faire.
    // (cas normal : les clics formule maintiennent déjà les recs, snapshot déjà à jour)
    let same = (field.length === MODEL.length);
    if(same){ for(let i=0;i<field.length;i++){ if(MODEL[i].glyph !== field[i]){ same=false; break; } } }
    if(same){ fieldSnapshotBefore = field.slice(); return; }

    // Socle inchangé entre AVANT et APRÈS : ces positions du champ n'ont pas bougé, les recs
    // correspondants sont conservés tels quels. Ce qui reste = les LOTS (suppressions/ajouts).
    const pairs = lcsPairs(before, field);
    const matchedBefore = new Set(pairs.map(p => p[0]));
    const matchedField  = new Set(pairs.map(p => p[1]));

    // Map position champ APRÈS (appariée) -> position champ AVANT (appariée), pour retrouver
    // le rec d'origine. On suppose MODEL[i] <-> before[i] en entrée (invariant maintenu).
    const fieldToBefore = new Map(pairs.map(p => [p[1], p[0]]));

    // Reconstruire MODEL en parcourant le champ APRÈS :
    //  - position appariée -> réutiliser le rec d'origine (préserve id + caseId).
    //  - position NON appariée -> glyphe d'un lot AJOUTÉ -> nouveau rec caseId=null.
    // Les recs dont la position AVANT n'est plus appariée = lot SUPPRIMÉ -> abandonnés.
    //
    // Désambiguïsation par signature de contexte : quand plusieurs positions AVANT non
    // appariées portent le même glyphe qu'une position APRÈS non appariée, on ne devine pas —
    // le socle LCS a déjà ancré tout ce qui est stable, donc une position non appariée est
    // réellement un ajout (pas un déplacement). L'appariement du socle EST la signature de
    // contexte : deux occurrences du même glyphe ne sont fusionnées que si leur voisinage
    // stable concorde, ce que le LCS garantit position par position.
    const newModel = [];
    for(let fi=0; fi<field.length; fi++){
      if(matchedField.has(fi)){
        const bi = fieldToBefore.get(fi);
        const rec = (bi < MODEL.length && MODEL[bi] && MODEL[bi].glyph === field[fi])
                    ? MODEL[bi]
                    : { id: MODEL_nextId++, glyph: field[fi], caseId: null };
        newModel.push(rec);
      } else {
        // glyphe d'un lot ajouté (collage / frappe) : rec neuf, origine non-formule
        newModel.push({ id: MODEL_nextId++, glyph: field[fi], caseId: null });
      }
    }

    // Cas résiduel — ambiguïté irréductible : séquence strictement identique de bout en bout
    // (recs interchangeables). Le LCS a alors tout apparié, aucun lot : on tombe dans 'same'
    // plus haut. Si on arrive ici avec des glyphes identiques non tranchés, l'ordre existant
    // des recs est conservé sans mutation de caseId (pas de réattribution hasardeuse).

    MODEL.length = 0;
    for(const r of newModel){ MODEL.push(r); }
    fieldSnapshotBefore = field.slice();
  }


  // Synchronise la div miroir avec le contenu de l'input (E1 : texte brut)
  function syncMirror(result, glyphs){
    const inner = document.createElement('span');
    inner.className = 'mirror-inner';

    // La miroir affiche la valeur RÉELLE de l'input (qui contient le ◌ si trou).
    const raw = Array.from(inputEl.value);

    // Index du caractère fautif à colorer rouge dans le champ. Fautes = no_match, tous les
    // wrong_* (wrong_kind, wrong_part, wrong_value...), abandoned (R08b), et doublon. Ces glyphes
    // sont posés dans le champ mais invalides -> rouge sur le glyphe lui-même (pas une case).
    const wrongRawSet = new Set();
    const errList = result.errors || (result.errorAt >= 0 ? [{at:result.errorAt, kind:result.errorKind}] : []);
    const isFaultKind = (k)=> k==='no_match' || k==='bad_value' || (typeof k==='string' && k.indexOf('wrong_')===0);
    errList.forEach(e => {
      const isFault = isFaultKind(e.kind) || e.abandoned;
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
    const HOLE_KIND_STRUCT = ['need_part','need_subpart','need_selection','need_subselection'];
    const HOLE_KIND_VALUE  = ['need_variable','need_var','need_subvar','need_var_or_subvar','need_value','value_due'];
    raw.forEach((ch, i) => {
      const sp = document.createElement('span');
      sp.setAttribute('data-rawidx', i);
      if(ch === DOT){
        // forme selon le kind de CE ◌ (retrouvé par sa position brute dans lastHoleInfos).
        const info = lastHoleInfos.find(h => h.rawPos === i);
        let form = null;
        if(info && info.kind){
          if(HOLE_KIND_STRUCT.includes(info.kind)) form = 'round';
          else if(HOLE_KIND_VALUE.includes(info.kind)) form = 'square';
        }
        sp.className = 'ins-caret';
        if(form){
          const img = document.createElement('img');
          img.className = 'ins-caret-svg';
          img.setAttribute('data-form', form);
          img.src = DOT_SVG_URLS[form].red;   // rouge par défaut ; passe en bleu si ◌ actif (résolution)
          img.alt = '';
          sp.appendChild(img);
        } else {
          sp.textContent = ch;   // fallback : ◌ texte si kind inconnu
        }
      } else {
        sp.textContent = ch;
        if(wrongRawSet.has(i)){
          sp.className = 'ch-wrong';          // faute en rouge
        } else if(orangeRaw.has(i)){
          sp.className = 'ch-impact';         // impacté en orange
        }
      }
      inner.appendChild(sp);
    });

    getMirror().innerHTML = '';
    getMirror().appendChild(inner);
    getMirror().scrollLeft = inputEl.scrollLeft;
  }

  let isSyncing = false; // anti-récursion lors de la manipulation de l'input

  // Mémoire : dernier placement connu des glyphes interactifs.
  // Map: signature du glyphe orphelin -> nom du doigt où il était placé.
  // On stocke, pour le dernier état VALIDE, la liste {glyph, fingerName, caseIdx}.
  let lastResult = null;        // dernier résultat de validate (pour hover/clavier)
  let lastHoleInfos = [];       // [{rawPos, kind, target}] : chaque ◌ et ce qui le résout
  let prevHoleCount = 0;        // nb de ◌ au rendu précédent (pour détecter une création)
  let prevHoleTargets = [];     // cases cibles des ◌ au rendu précédent
  let lastCreatedHoleTarget = -1; // case cible du DERNIER ◌ créé temporellement (focus par défaut)
  function onInputChanged(reason){
    if(isSyncing) return; // ignore les events déclenchés par notre propre manipulation
    if(typeof modelClear === 'function' && (reason === 'clear' || reason === 'init')){
      modelClear();
      fieldSnapshotBefore = [];
    }
    // GESTES qui touchent le champ SANS maintenir les recs (clavier virtuel, frappe physique,
    // collage, coupe) : réconcilier les recs par enquête de contexte (D14). Les clics formule
    // et la résolution ('clic-formule' / 'resolution') maintiennent déjà les recs avec leur
    // caseId via modelAdd/modelRemove — ils ne passent PAS par cette réconciliation.
    const NATIVE = (reason === 'edit' || reason === 'clic' || reason === 'cut');
    const MAINTAINED = (reason === 'clic-formule' || reason === 'resolution');
    if(typeof modelReconcileWithField === 'function' && NATIVE){
      modelReconcileWithField();
    } else if(MAINTAINED || reason === 'init' || reason === 'clear'){
      // le MODEL vient d'être muté (ou vidé) hors réconciliation : réancrer le snapshot AVANT
      // sur l'état courant du champ, pour que le PROCHAIN geste natif diffe contre le bon état.
      fieldSnapshotBefore = Array.from(inputEl.value).filter(ch => ch !== DOT);
    }

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
    // Tout kind need_* (manque à combler) + value_due génère un ◌. Les fautes (wrong_*, no_match,
    // abandoned) ne génèrent PAS de ◌ (rien à insérer, c'est à corriger/retirer -> rouge).
    const HOLE_KINDS_DOT = ['need_part','need_subpart','need_selection','need_subselection',
                            'need_subvar','need_var','need_var_or_subvar','value_due'];
    const holePositions = [];
    const allErrs = result.errors || (result.errorAt >= 0 ? [{at:result.errorAt, kind:result.errorKind}] : []);
    allErrs.forEach(e => {
      const isHole = HOLE_KINDS_DOT.includes(e.kind) && !e.abandoned; // abandoned = faute, pas trou
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
      const holeErrs = (result.errors||[]).filter(e => HOLE_KINDS_DOT.includes(e.kind) && !e.abandoned);
      // recalculer les positions RAW des ◌ dans newValue
      const rawArr = Array.from(newValue);
      let filteredIdx = 0, hi = 0;
      const sortedHoles = holePositions.slice().sort((a,b)=>a-b); // croissant
      for(let i=0;i<rawArr.length;i++){
        if(rawArr[i] === DOT){
          // ce ◌ correspond au hole sortedHoles[hi]
          const fpos = sortedHoles[hi];
          const err = holeErrs.find(e => e.at === fpos);
          lastHoleInfos.push({rawPos:i, kind: err?err.kind:null, target: err?err.target:-1, at: err?err.at:-1});
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
    function removeAnchorGlyph(anchorIdx){
      // retirer le glyphe fixe de l'ancre (quel que soit son niveau) du champ + modèle
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
    // GÉNÉRIQUE : remonter TOUTE la colonne d'ancres parentes du bloc, du niveau le plus BAS
    // (immédiat) au plus HAUT. Retirer chaque ancre dont la sous-arborescence n'a plus aucun
    // bloc rempli. On s'arrête dès qu'une ancre a encore du contenu (les ancres au-dessus la
    // couvrent forcément). Aucun niveau nommé : la profondeur de la chaîne décide de tout.
    const anchors = parentAnchorsBottomUp(refCaseIdx); // [immédiat, ..., plus haut]
    for(const anchorIdx of anchors){
      const _g = toGlyphs(inputEl.value);
      const _r = validate(_g, (typeof modelCaseIds==='function'?modelCaseIds():[]));
      if(subtreeHasFilledBlock(anchorIdx, _r.st)) break; // encore du contenu -> stop (et au-dessus aussi)
      removeAnchorGlyph(anchorIdx);
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
      // signature de bloc UNIVERSELLE : chaîne d'ancres (générique) + la variable au-dessus
      // (distingue les blocs frères sous une même ancre : flxext / abdadd / rinrex...).
      // Aucun niveau nommé : on lit la chaîne d'ancrage et le 1er 'variable' rencontré en amont.
      function segmentOf(caseIdx){
        let v=-1;
        for(let i=caseIdx;i>=0;i--){
          if(CASES[i].kind==='variable'){ v=i; break; }
          if(isAnchorKind(CASES[i].kind)) break; // remonté jusqu'à une ancre sans variable
        }
        return anchorSignature(caseIdx) + '#v' + (v>=0 ? (CASES[v].fixedGlyph||v) : '-');
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
    // 1. Déterminer les ancres nécessaires : TOUTE la chaîne d'ancres de la case cliquée.
    //    Universel : le SOMMET de branche (niveau le plus haut hors AS) peut être PARTAGÉ par
    //    plusieurs segments -> on l'injecte seulement si son glyphe est absent du champ. Les
    //    niveaux plus PROFONDS sont propres à un segment précis -> on les injecte si LEUR case
    //    n'est pas déjà remplie. Aucun niveau n'est nommé : c'est la profondeur qui décide.
    const toInsert = []; // liste de {glyph, caseIdx}
    const fieldGlyphs = toGlyphs(inputEl.value);
    const chain = CASES[clickedCaseIdx] ? CASES[clickedCaseIdx].anchorChain : [];
    // niveau du sommet de branche = plus petit level > 0 (l'AS est level 0)
    let topLevel = Infinity;
    chain.forEach(a => { if(a.level > 0 && a.level < topLevel) topLevel = a.level; });
    chain.forEach(a => {
      if(a.level === 0) return; // AS (racine) : jamais injecté comme ancre
      const ag = a.glyph || (CASES[a.caseIdx] ? CASES[a.caseIdx].fixedGlyph : null);
      if(!ag) return;
      if(a.level === topLevel){
        // sommet de branche (potentiellement partagé) : injecter si glyphe absent du champ
        if(!fieldGlyphs.includes(ag)) toInsert.push({glyph: ag, caseIdx: a.caseIdx});
      } else {
        // niveau propre à un segment : injecter si cette case d'ancre n'est pas déjà remplie
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
      // la variable fixe juste avant la subvar (s'arrêter à toute ancre, quel que soit son niveau)
      for(let i = (subvarCase>=0?subvarCase:clickedCaseIdx); i >= 0; i--){
        if(CASES[i].kind === 'variable'){ varCase = i; break; }
        if(isAnchorKind(CASES[i].kind)){ break; }
      }
      if(varCase >= 0 && CASES[varCase].fixedGlyph && !caseAlreadyFilled(varCase)){
        toInsert.push({glyph: CASES[varCase].fixedGlyph, caseIdx: varCase});
      }
      // Retirer la VALUE existante du bloc : ref pos + zero prennent la main (option A).
      // ROBUSTE : le validateur peut avoir placé la value (ex: full ambigu) dans un AUTRE
      // bloc value du même segment (part+subpart). On cherche donc la value orpheline/remplie
      // du même segment que le bloc cliqué, où qu'elle soit dans st.
      if(valueCase >= 0){
        const curG = toGlyphs(inputEl.value);
        const curR = validate(curG, (typeof modelCaseIds==='function'?modelCaseIds():[]));
        let victimSrcChar = -1;
        // Retirer UNIQUEMENT la value du BLOC cliqué. Depuis que le validateur place via les recs
        // (caseId), chaque value est déjà dans son bloc : on lit directement la value du bloc
        // cliqué (valueCase), aucun repérage de segment nommé n'est nécessaire.
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
  inputEl.addEventListener('scroll', () => { getMirror().scrollLeft = inputEl.scrollLeft; });

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
    const spans = Array.from(getMirror().querySelectorAll('.mirror-inner > span:not(.blink-caret)'));
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
    // helper : une ancre (part/subpart) ne résout QUE si l'insérer dans la formule
    // complète (juste avant le glyphe orphelin) réduit réellement le nombre d'erreurs.
    // Même critère que findCandidateCells -> cohérence formule/clavier.
    function anchorsThatResolve(candidateGlyphs){
      const _g = toGlyphs(inputEl.value);
      const _r = validate(_g, (typeof modelCaseIds==='function'?modelCaseIds():[]));
      const base = (_r.errors||[]).length;
      // position du glyphe orphelin dans la séquence filtrée = hole.at si dispo, sinon fin
      const at = (hole.at != null && hole.at >= 0) ? hole.at : _g.length;
      const out = [];
      for(const cand of candidateGlyphs){
        const test = _g.slice(0, at).concat([cand], _g.slice(at));
        if((validate(test, []).errors||[]).length < base) out.push(cand);
      }
      return out;
    }
    // Les glyphes résolvants dépendent du KIND du manque, pas seulement de la case cible.
    // GÉNÉRIQUE : pour tout manque d'ancrage (need_selection/part/subpart/subselection), proposer
    // les glyphes-ancres du bon kind qui résolvent vraiment (critère réduction d'erreurs).
    const holeAnchorKind = anchorKindOfNeed(hole.kind);
    if(holeAnchorKind){
      glyphs = anchorsThatResolve(ANCHOR_GLYPHS_BY_KIND[holeAnchorKind] || []);
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
    const spans = Array.from(getMirror().querySelectorAll('.mirror-inner > span:not(.blink-caret)'));
    // reset : chaque ◌ (img SVG) repasse en ROUGE (rouge = manque, pas encore résolution active).
    spans.forEach(s => {
      s.classList.remove('ins-caret-blue');
      const img = s.querySelector('img.ins-caret-svg');
      if(img){ const f = img.getAttribute('data-form'); if(f && DOT_SVG_URLS[f]) img.src = DOT_SVG_URLS[f].red; }
    });
    // Déterminer le ◌ ACTIF : celui sous le curseur, sinon le DERNIER créé TEMPORELLEMENT.
    let activeHole = ctx.hole;
    if(!activeHole && lastHoleInfos.length){
      activeHole = lastHoleInfos.find(h => h.target === lastCreatedHoleTarget)
                   || lastHoleInfos[lastHoleInfos.length - 1];
    }
    // ◌ actif (curseur dessus) -> BLEU : on injecte le SVG bleu de sa forme.
    if(ctx.hole && spans[ctx.hole.rawPos]){
      spans[ctx.hole.rawPos].classList.add('ins-caret-blue');
      const img = spans[ctx.hole.rawPos].querySelector('img.ins-caret-svg');
      if(img){ const f = img.getAttribute('data-form'); if(f && DOT_SVG_URLS[f]) img.src = DOT_SVG_URLS[f].blue; }
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
    const inner = getMirror().querySelector('.mirror-inner');
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
      const spans = Array.from(getMirror().querySelectorAll('.mirror-inner > span:not(.blink-caret)'));
      spans.forEach(s => s.classList.remove('ins-caret-hover-blue'));
      if(h && spans[h.rawPos]) spans[h.rawPos].classList.add('ins-caret-hover-blue');
    });
    c.span.addEventListener('mouseleave', () => {
      const spans = Array.from(getMirror().querySelectorAll('.mirror-inner > span:not(.blink-caret)'));
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
    getMirror().querySelectorAll('span.link-violet').forEach(e => e.classList.remove('link-violet'));
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
      const sp = getMirror().querySelector('.mirror-inner > span[data-rawidx="'+rawPos+'"]');
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
    const spans = Array.from(getMirror().querySelectorAll('.mirror-inner > span[data-rawidx]:not(.blink-caret)'));
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
