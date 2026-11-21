// Filtro de secretos.
//
// Corre ANTES de escribir, no solo antes de enviar: un token en
// .tambo/branches/<slug>/relevo.md ya es una fuga aunque nunca salga de la máquina.
//
// Lo redactado deja marca visible para que nadie confunda una redacción con
// un dato ausente.

const PATTERNS = [
  // Credenciales con prefijo reconocible
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, 'clave-anthropic'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'clave-api'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, 'clave-google'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, 'token-github'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'token-github'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'token-slack'],
  [/\bxapp-\d-[A-Za-z0-9-]{10,}\b/g, 'token-slack'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'clave-aws'],
  [/\bASIA[0-9A-Z]{16}\b/g, 'clave-aws-temporal'],
  [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, 'token-gitlab'],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, 'token-npm'],
  [/\bdop_v1_[a-f0-9]{32,}\b/g, 'token-digitalocean'],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, 'clave-sendgrid'],
  [/\bsk_live_[A-Za-z0-9]{16,}\b/g, 'clave-stripe'],
  [/\brk_live_[A-Za-z0-9]{16,}\b/g, 'clave-stripe'],
  [/\bwhsec_[A-Za-z0-9]{24,}\b/g, 'secreto-webhook-stripe'],
  [/\bhf_[A-Za-z0-9]{30,}\b/g, 'token-huggingface'],
  [/\bpypi-[A-Za-z0-9_-]{32,}\b/g, 'token-pypi'],
  [/\bsbp_[a-f0-9]{32,}\b/g, 'token-supabase'],
  [/\bsb_secret_[A-Za-z0-9_-]{20,}\b/g, 'token-supabase'],
  [/\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b/g, 'token-shopify'],
  [/\bdapi[a-f0-9]{32}\b/g, 'token-databricks'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, 'token-telegram'],
  [/\b[MN][A-Za-z\d]{23,28}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/g, 'token-discord'],
  [/\bre_[A-Za-z0-9_]{24,}\b/g, 'clave-resend'],
  [/\bdckr_pat_[A-Za-z0-9_-]{24,}\b/g, 'token-docker'],
  [/\bSK[0-9a-fA-F]{32}\b/g, 'clave-twilio'],

  // Formatos estructurados
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'jwt'],
  [/-----BEGIN[A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g, 'clave-privada'],

  // Asignaciones con nombre sensible: TOKEN=..., api_secret: "...", "password": "..."
  [/((?:["']|\b)(?:[A-Za-z_][A-Za-z0-9_]*)?(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL|ACCESS_KEY)[A-Za-z0-9_]*["']?\s*[:=]\s*)["']?([^\s"',;\][]{8,})["']?/gi, 'asignacion'],
  // Flags de línea de comando con nombre sensible: --token xxx, --api-key=xxx, --password 'xxx'
  [/((?:^|[\s"'`])--[A-Za-z0-9-]*(?:secret|token|password|passwd|api-?key|private-?key|access-?key)[A-Za-z0-9-]*(?:\s*=\s*|\s+))["']?([^\s"',;\][]{8,})["']?/gi, 'flag-secreto'],

  // URL con credenciales embebidas
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):(?!\[redactado\]@)([^\s:/@]+)@/gi, 'url-con-credencial'],

  // Cabeceras Authorization y X-API-Key
  [/\b(Authorization\s*:\s*(?:Bearer|Basic|token)\s+)([A-Za-z0-9._~+/=-]{12,})/gi, 'cabecera-auth'],
  [/\b((?:x-)?api-key\s*:\s*)([A-Za-z0-9._~+/=-]{16,})/gi, 'cabecera-auth'],
];

// Patrones de usuario largos no aportan nada que uno corto no haga, y sí
// alargan el tiempo de cualquier retroceso que la heurística de abajo no
// atrape. chaski.json se versiona: esto no es para un usuario que se
// equivoca, es un techo contra un patrón que nadie miró con cuidado.
const MAX_USER_PATTERN_LEN = 200;

/**
 * ¿Esta forma de patrón puede producir retroceso catastrófico?
 *
 * Heurística, no un verificador — no existe uno sin dependencias, y escribir
 * uno sería el motor de regex que ya tenemos reimplementado peor. Cubre la
 * forma confirmada en esta máquina: `redact('a'.repeat(35) + '!', { redact:
 * ['(a+)+$'] })` se cuelga indefinidamente (8+ s antes de matarlo a mano).
 * La familia que causa esto es siempre la misma: un grupo que ya repite algo
 * por dentro (`+`, `*` o alternancia `|`) y que además se repite por fuera
 * — `(a+)+`, `(a*)*`, `(a|aa)+`. Eso es lo que se rechaza aquí.
 *
 * Lo que esto NO atrapa, a propósito, porque cubrirlo pide un parser de
 * regex completo y este archivo no lo tiene: cuantificadores anidados a
 * tres niveles (`((a+)+)+`), alternancia superpuesta sin agrupar
 * (`a*a*a*...`), y cualquier patrón que sea lento por razones que no son
 * retroceso exponencial (p. ej. una alternancia con cientos de ramas). El
 * tope de longitud de abajo y el techo de `chaski.json` versionado — un
 * patrón ajeno pasa por code review antes de ejecutarse — son la segunda
 * línea de defensa para lo que se escapa de la heurística.
 */
function isCatastrophicShape(source) {
  let s = String(source);
  for (let i = 0; i < 4; i++) {
    const next = s
      .replace(/\(([^()+*|{}]+)\)(?=[*+?]|\{\d)/g, '$1')
      .replace(/\(([^()]+)\)(?![*+?{])/g, '$1');
    if (next === s) break;
    s = next;
  }
  return /\([^()]*[+*|][^()]*\)(?:[*+]|\{\d+,|\{[4-9]\d*\}|\{\d{2,}\})/.test(s);
}

/**
 * Compila patrones del usuario descartando los demasiado largos, los de forma
 * catastrófica y los que no compilan. Lo comparten `redact` y `excludePaths`.
 */
const avisados = new Set();

function safeUserRegexes(lista, flags, clave) {
  const out = [];
  if (!Array.isArray(lista)) return out;
  for (const p of lista) {
    if (typeof p !== 'string' || !p || p.length > MAX_USER_PATTERN_LEN) continue;
    if (isCatastrophicShape(p)) {
      // Un aviso por patrón y proceso: isExcludedPath corre una vez por
      // archivo, y repetirlo llenaría stderr del hook en cada turno.
      const k = `${clave}\0${p}`;
      if (!avisados.has(k)) {
        avisados.add(k);
        process.stderr.write(`chaski: patrón de ${clave} ignorado, puede colgar el hook: ${p}\n`);
      }
      continue;
    }
    try {
      const re = new RegExp(p, flags);
      if (re.test('')) continue;
      out.push(re);
    } catch {}
  }
  return out;
}

// En un transcript se aplican los mismos patrones a miles de comandos.
// Cada lector conserva su conjunto compilado durante toda la lectura.
export function createRedactor(config = null) {
  const extra = safeUserRegexes(config?.redact, 'g', 'redact').map((re) => [re, 'patron-usuario']);
  const patterns = extra.length ? [...PATTERNS, ...extra] : PATTERNS;
  return (text) => redactText(text, patterns);
}

/** Redacción para un texto individual. */
export function redact(texto, config = null) {
  if (!texto) return { texto: '', redactions: 0 };
  return createRedactor(config)(texto);
}

function redactText(texto, patterns) {
  if (!texto) return { texto: '', redactions: 0 };
  let out = String(texto);
  let n = 0;

  // Lo que el usuario marcó como privado no pasa de aquí, sea secreto o no
  // (un nombre de cliente, una cifra, una conversación): ningún patrón puede
  // adivinar eso, así que la marca la pone quien sabe. Ojo: lo que no pasa por
  // redact() no se filtra; la narrativa que el agente escribe en estado.json
  // queda tal cual hasta que se renderiza, se archiva en historia/ o se
  // muestra (relevo, why, share), donde sí pasa. Va primero para que
  // nada de adentro llegue a los patrones de abajo. Una etiqueta sin cerrar
  // tapa hasta el final: ante la duda, se calla de más y no de menos.
  out = out.replace(/<private>[\s\S]*?(?:<\/private>|$)/gi, () => {
    n++;
    return '[privado]';
  });

  for (const [re, etiqueta] of patterns) {
    out = out.replace(re, (match, ...grupos) => {
      n++;
      // En asignaciones, URLs y cabeceras se conserva la parte no secreta
      // para que el texto siga siendo legible.
      if (etiqueta === 'asignacion') return `${grupos[0]}[redactado: secreto]`;
      if (etiqueta === 'flag-secreto') return `${grupos[0]}[redactado: secreto]`;
      if (etiqueta === 'url-con-credencial') return `${grupos[0]}${grupos[1]}:[redactado]@`;
      if (etiqueta === 'cabecera-auth') return `${grupos[0]}[redactado]`;
      return `[redactado: ${etiqueta}]`;
    });
  }

  // Cadenas largas de alta entropía que ningún patrón nombró.
  out = out.replace(/\b[A-Za-z0-9+/=_-]{40,}\b/g, (m) => {
    if (isLikelyNonSecretIdentifier(m) || !hasHighEntropy(m)) return m;
    n++;
    return '[redactado: cadena-de-alta-entropia]';
  });

  return { texto: out, redactions: n };
}

function isLikelyNonSecretIdentifier(s) {
  // SHA-1 (40 hex) o SHA-256 (64 hex) sueltos suelen ser commits de git; si
  // venían en SECRET=... o --token=..., los patrones de arriba ya los taparon.
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(s)) return true;
  // Rutas de archivo, ramas de git o identificadores camelCase/kebab-case/snake_case:
  // si tiene `/` sin `+` ni `=` final (o varios segmentos de letras con `-`/`_`/`/`),
  // o solo letras/guiones sin dígitos, no es un token aleatorio en base64/urlsafe.
  if (s.includes('/') && !/[+=]/.test(s)) return true;
  if (!/\d/.test(s) && !/[+/=]/.test(s)) return true;
  if ((s.match(/[-_/]/g) ?? []).length >= 3 && !/[+=]/.test(s)) return true;
  return false;
}

/**
 * Entropía de Shannon por carácter. Un token aleatorio supera ~4.1 bits;
 * una palabra o un identificador en código queda por debajo.
 */
function hasHighEntropy(s, umbral = 4.1) {
  const freq = Object.create(null);
  for (const c of s) freq[c] = (freq[c] || 0) + 1;
  let h = 0;
  for (const c in freq) {
    const p = freq[c] / s.length;
    h -= p * Math.log2(p);
  }
  return h >= umbral;
}

const DEFAULT_EXCLUSIONS = [
  // Lo que chaski mismo escribe: nunca es parte del trabajo del usuario.
  /(^|[\\/])\.tambo([\\/]|$)/i,
  /(^|[\\/])chaski\.local\.json$/i,
  /(^|[\\/])\.env($|\.|rc$|[\\/])/i,
  /(^|[\\/])\.?(credentials|secrets?)($|[\\/.])/i,
  /\.(pem|key|pfx|p12|keystore|jks|ppk)$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)($|\.)/i,
  /(^|[\\/])\.(?:npmrc|netrc|pypirc|git-credentials|pgpass|htpasswd)$/i,
  /(^|[\\/])(?:_netrc|\.my\.cnf|application_default_credentials\.json)$/i,
  /\.(?:tfstate(?:\.backup)?|tfvars)$/i,
  /(^|[\\/])\.(?:aws|ssh)[\\/]/i,
  /(^|[\\/])\.(?:docker[\\/]config\.json|kube[\\/]config)$/i,
];

export function createPathFilter(config = null) {
  const extra = safeUserRegexes(config?.excludePaths, 'i', 'excludePaths');
  const patterns = extra.length ? [...DEFAULT_EXCLUSIONS, ...extra] : DEFAULT_EXCLUSIONS;
  return (path) => patterns.some((pattern) => pattern.test(path));
}

/** ¿Esta ruta debe quedar fuera del relevo? */
export function isExcludedPath(path, config = null) {
  return createPathFilter(config)(path);
}

/**
 * Quita datos personales de un texto que se va a publicar (`chaski share`
 * escribe en `decisiones/`, que se versiona). No es redacción de secretos —
 * eso ya lo hizo redact()—: es lo que no es secreto pero tampoco tiene por
 * qué quedar en la historia de git de un repo ajeno: la carpeta personal con
 * el nombre de usuario adentro y los correos.
 *
 * Solo para lo que se publica. El relevo local no se anonimiza: ahí una ruta
 * absoluta es información útil para el agente siguiente y no sale de la
 * máquina.
 */
export function anonymize(texto, { home = '' } = {}) {
  if (!texto) return { texto: '', anonymized: 0 };
  let out = String(texto);
  let n = 0;
  const contar = (reemplazo) => () => { n++; return reemplazo; };

  // La carpeta personal exacta primero, con cualquiera de los dos separadores
  // (en Windows una narrativa puede traer `C:\Users\x` o `C:/Users/x`).
  if (home && home.length > 3) {
    const SEP = String.raw`[\\/]`;
    const partes = home.split(/[\\/]+/).filter(Boolean)
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const prefijo = /^[\\/]/.test(home) ? SEP : '';
    const re = new RegExp(prefijo + partes.join(SEP + '+') + String.raw`(?=[\\/]|\b|$)`, 'gi');
    out = out.replace(re, contar('~'));
  }
  // Carpetas personales de cualquier otro usuario o máquina. Solo al INICIO de
  // una ruta (tras un espacio, una comilla, un paréntesis o el principio): un
  // `/home/` o `/Users/` en medio de una URL o de una ruta del repo
  // (`https://app.com/home/x`, `src/Users/Profile.ts`) no es una carpeta
  // personal, y reemplazarlo dejaba texto roto en algo que se versiona.
  out = out.replace(/(^|[\s"'`(=])((?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/\s`'"<>]+)/gim,
    (_, antes) => { n++; return `${antes}~`; });
  // El dominio termina en letras: `paquete@1.2.3` es una versión, no un correo.
  // Y `git@github.com:org/repo` es una URL de git, no un correo: se excluye lo
  // que sigue con `:`.
  out = out.replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b(?!:)/g, contar('[correo]'));
  return { texto: out, anonymized: n };
}
