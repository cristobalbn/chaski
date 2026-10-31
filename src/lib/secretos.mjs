// Filtro de secretos.
//
// Corre ANTES de escribir, no solo antes de enviar: un token en
// .tambo/relevo.md ya es una fuga aunque nunca salga de la máquina.
//
// Lo redactado deja marca visible para que nadie confunda una redacción con
// un dato ausente.

const PATRONES = [
  // Credenciales con prefijo reconocible
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'clave-api'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, 'clave-anthropic'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, 'clave-google'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, 'token-github'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'token-github'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'token-slack'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'clave-aws'],
  [/\bASIA[0-9A-Z]{16}\b/g, 'clave-aws-temporal'],
  [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, 'token-gitlab'],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, 'token-npm'],
  [/\bdop_v1_[a-f0-9]{32,}\b/g, 'token-digitalocean'],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, 'clave-sendgrid'],
  [/\bsk_live_[A-Za-z0-9]{16,}\b/g, 'clave-stripe'],
  [/\brk_live_[A-Za-z0-9]{16,}\b/g, 'clave-stripe'],

  // Formatos estructurados
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'jwt'],
  [/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, 'clave-privada'],

  // Asignaciones con nombre sensible: TOKEN=..., api_secret: "...", PASSWORD = '...'
  [/\b([A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL|ACCESS_KEY)[A-Za-z0-9_]*)\s*[:=]\s*["']?([^\s"',;]{8,})["']?/gi, 'asignacion'],

  // URL con credenciales embebidas
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s:/@]+)@/gi, 'url-con-credencial'],

  // Cabecera Authorization
  [/\b(Authorization\s*:\s*(?:Bearer|Basic|token)\s+)([A-Za-z0-9._~+/=-]{12,})/gi, 'cabecera-auth'],
];

/** Patrones extra del usuario, desde chaski.json → redact: ["..."] */
function patronesUsuario(config) {
  const extra = [];
  for (const p of (config?.redact ?? [])) {
    try { extra.push([new RegExp(p, 'g'), 'patron-usuario']); } catch {}
  }
  return extra;
}

/**
 * Redacta el texto. Devuelve { texto, redacciones } — el conteo sirve para
 * que el relevo declare que hubo redacciones en lugar de callarlas.
 */
export function redactar(texto, config = null) {
  if (!texto) return { texto: '', redacciones: 0 };
  let out = String(texto);
  let n = 0;

  for (const [re, etiqueta] of [...PATRONES, ...patronesUsuario(config)]) {
    out = out.replace(re, (match, ...grupos) => {
      n++;
      // En asignaciones, URLs y cabeceras se conserva la parte no secreta
      // para que el texto siga siendo legible.
      if (etiqueta === 'asignacion') return `${grupos[0]}=[redactado: secreto]`;
      if (etiqueta === 'url-con-credencial') return `${grupos[0]}${grupos[1]}:[redactado]@`;
      if (etiqueta === 'cabecera-auth') return `${grupos[0]}[redactado]`;
      return `[redactado: ${etiqueta}]`;
    });
  }

  // Cadenas largas de alta entropía que ningún patrón nombró.
  out = out.replace(/\b[A-Za-z0-9+/=_-]{40,}\b/g, (m) => {
    if (!altaEntropia(m)) return m;
    n++;
    return '[redactado: cadena-de-alta-entropia]';
  });

  return { texto: out, redacciones: n };
}

/**
 * Entropía de Shannon por carácter. Un hash o un token supera ~3.5 bits;
 * una palabra o un identificador en código queda por debajo.
 */
function altaEntropia(s, umbral = 3.6) {
  const freq = Object.create(null);
  for (const c of s) freq[c] = (freq[c] || 0) + 1;
  let h = 0;
  for (const c in freq) {
    const p = freq[c] / s.length;
    h -= p * Math.log2(p);
  }
  return h >= umbral;
}

/** ¿Esta ruta no debe aparecer nunca en el relevo? */
export function rutaExcluida(ruta, config = null) {
  const defecto = [
    // Lo que chaski mismo escribe: nunca es parte del trabajo del usuario.
    /(^|[\\/])\.tambo([\\/]|$)/i,
    /(^|[\\/])chaski\.local\.json$/i,
    /(^|[\\/])\.env($|\.|[\\/])/i,
    /(^|[\\/])\.?(credentials|secrets?)($|[\\/.])/i,
    /\.(pem|key|pfx|p12|keystore|jks)$/i,
    /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)($|\.)/i,
    /(^|[\\/])\.npmrc$/i,
    /(^|[\\/])\.aws[\\/]/i,
  ];
  const extra = (config?.excludePaths ?? []).map((p) => {
    try { return new RegExp(p, 'i'); } catch { return null; }
  }).filter(Boolean);

  return [...defecto, ...extra].some((re) => re.test(ruta));
}
