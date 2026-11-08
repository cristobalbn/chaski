# Auditoría multicapa — noviembre de 2026

Qué se auditó, cómo, qué se encontró y qué se decidió no arreglar. Está aquí
porque los hallazgos de una auditoría se olvidan y los defectos que nadie
escribió vuelven a descubrirse dos veces.

El disparador: la homologación del código al inglés (#16) renombró módulos y
claves de JSON, y dejó dos bugs que ni la verificación de sintaxis ni los 95
tests de entonces detectaron. Uno escribía una clave con un nombre y la leía
con otro; el otro dejó viva la referencia a una constante renombrada, en una
rama de código poco transitada. Los dos pasaron a producción. La pregunta que
originó esta auditoría no fue "¿qué más se rompió?" sino **"¿por qué nuestras
defensas no lo vieron?"**.

## Método

Once agentes en tres capas, cada uno sin contacto con los demás:

| Capa | Quiénes | Encargo |
|---|---|---|
| 1 | 5 auditores | Buscar defectos, cada uno con una hipótesis distinta. Evidencia ejecutada o el hallazgo no se reporta |
| 2 | 4 validadores | Recibir los hallazgos **como afirmaciones desnudas**, sin la evidencia ni el razonamiento de quien los encontró, y confirmarlos o refutarlos por su cuenta |
| 3 | 2 meta-validadores | Auditar a los validadores: veredictos mal fundados, severidades torcidas, convergencia falsa, contradicciones, y qué no miró nadie |

Tres reglas sostuvieron el proceso:

- **Refutar vale tanto como confirmar.** Una afirmación plausible y falsa es
  peor que un bug: alguien arregla lo que no estaba roto y rompe otra cosa.
- **Cada capa asigna su propia severidad**, sin heredar la anterior.
- **Quien confirma un defecto dice qué podría romper el arreglo.**

La capa 2 trabajó a ciegas a propósito. Si se les pasa la evidencia, validan el
razonamiento ajeno en lugar de volver a derivar el hecho.

## Lo que el método encontró y la revisión humana no

Los defectos más graves no fueron los más visibles.

**El comando `/relevo` estaba roto en silencio.** `skill/SKILL.md` instruía al
modelo a escribir `narrativa` / `narrativaAutor` / `narrativaEscrita`, y el
código lee `narrative` / `narrativeAuthor` / `narrativeWrittenAt`. La narrativa
—el porqué, lo que quedó a medias, el siguiente paso: lo único que no se puede
derivar de git— se escribía en claves muertas y `capture.mjs` la sobrescribía
al turno siguiente. El relevo seguía viéndose razonable porque los hechos sí
viajaban. Es la misma clase de bug que el commit del renombre dice haber
cazado, en el único archivo que ese commit no revisó con esa lupa.

**El filtro de secretos no estaba probado.** Sus 14 tests verificaban que
*algo* quedó marcado como redactado, nunca que el secreto desapareció: una
mutación que deja la credencial intacta y le pega la etiqueta al lado pasaba 94
de 95 tests. El test de integración era doblemente inútil: afirmaba la ausencia
de una cadena que no estaba en ningún fixture, y el secreto nunca llegaba al
campo comparado porque `meaningfulLine()` lo descartaba antes. Catorce tests
daban cobertura falsa precisamente por ser muchos.

**La suite escribía en el `~/.chaski/` real** de cualquiera que la corriera, y
podía crear una clave HMAC ahí. La causa no fue descuido: en Windows, fijar
`HOME` no aísla nada, porque Node usa `USERPROFILE` para `homedir()`.

**Un ReDoS que congela el hook.** Lo encontró la capa 3, preguntándose qué no
miró nadie. Los patrones de `redact` en `chaski.json` se compilaban sin límite:
`(a+)+$` contra 40 caracteres colgaba el proceso indefinidamente. Viola el
invariante "los hooks nunca fallan" de la peor forma, porque no falla, se
congela. Y `chaski.json` **se versiona**, así que el patrón puede venir de un
compañero, de un repositorio clonado o de un PR aceptado sin leer.

## Correcciones de rumbo de la capa 3

Tres, y todas rebajan o precisan algo que las capas anteriores afirmaron:

- El agujero de la firma HMAC **no es un bypass de autenticación**. Quien puede
  escribir `estado.json` ya podía inyectar texto editando `relevo.md`, y en ese
  camino el aviso sí aparece. Lo que el defecto regalaba era **suprimir el
  rótulo** de "no verificado". Sigue habiendo que arreglarlo —importa en
  carpetas compartidas, donde dos personas usan el mismo `.tambo/` con claves
  distintas— pero la descripción original lo sobrevendía.
- Los umbrales medidos por la capa 1 estaban mal en los dos sentidos: el de
  ruta larga es ~240 caracteres, no 259; y el presupuesto de latencia se agota
  entre 4.000 y 6.000 archivos modificados, no en 10.000. Lo segundo cambia el
  carácter del problema: 10.000 archivos es un laboratorio, 4.000 es un
  `prettier --write`.
- La "triple confirmación" del bug del skill era más débil de lo que parecía.
  Los tres auditores partían de la misma pista del encargo y apuntaron al caso
  más obvio de esa categoría. Tres agentes que reciben la misma pista y la
  confirman no son tres pruebas.

Y un fallo de proceso que conviene dejar escrito: **el hallazgo más grave fue
el único que no pasó por la capa 2**, porque se dio por confirmado al
converger tres auditores. Que resultara real no valida la decisión.

## Lo que se arregló

- Las claves del skill, en las dos copias, verificadas contra el código.
- La firma se recalcula sobre el Markdown reconstruido en lugar de asumirse
  válida.
- Heurística que rechaza patrones de `redact` con forma catastrófica, más un
  tope de longitud. No es un verificador: lo que no cubre está en el comentario
  del código.
- `sealedAtLimit` aparece en el relevo. Cortarse por cuota es el caso que
  originó el proyecto y era el único que el relevo no contaba.
- `render()` defiende la forma de los seis campos que itera. Antes, un
  `subagents` con forma inesperada imprimía `undefined` una vez por carácter.
- `isInstalled` ya no se filtra a los mensajes en español; cuatro voseos menos.
- La suite aísla `HOME` **y** `USERPROFILE`, y hay un test que falla si alguien
  agrega una invocación sin aislarlas.
- Siete tests nuevos, cada uno verificado fallando con su defecto
  reintroducido a mano. Dos reproducen los bugs del renombre que se escaparon.

## Límites conocidos, decididos y no corregidos

El criterio fue el riesgo para el usuario, no la completitud. Un proyecto de
~3.100 líneas sin dependencias puede morir de sobre-ingeniería.

| Límite | Estado / Por qué |
|---|---|
| Rutas de más de ~240 caracteres rompen git y chaski reporta "no es un repositorio" | Se midió: no hay arreglo barato. Documentado para que el síntoma sea reconocible |
| 4.000–6.000 archivos modificados agotan el presupuesto de 1,5 s y se pierde el relevo | **Resuelto**: implementado presupuesto global en `src/lib/budget.mjs` con degradación controlada de hechos y reducción a 3 subprocesos git en PR #37 (~220-340 ms) |
| Sin migración de `.tambo/ramas/` | Mover archivos en disco ajeno, en una carpeta sincronizada, es peor que el huérfano. El README explica cómo recuperarlos a mano |
| `.tambo/branches/sin-rama/` mezcla inglés y español | Mismo problema que el anterior, y el nombre ya existe en disco |
| Falsa alarma de firma si un cliente de sincronización bloquea `estado.json` a mitad de escritura | La alarma es conservadora: el agente recibe la instrucción correcta de desconfiar |
| `doctor` siempre termina con código 0 | No sirve para encadenar en CI. Documentado; arreglarlo es trivial pero cambia un contrato |
| Nadie ejecutó nada fuera de Windows | **Resuelto**: suite validada en Linux y macOS vía `.github/workflows/test.yml` sobre Node 20, 22 y LTS, confirmando wrappers `.sh` y permisos POSIX |

## Lo que esta auditoría cambió en cómo se trabaja aquí

Tres convenciones nuevas en `AGENTS.md`, las tres nacidas de un defecto
concreto:

1. **Ningún test toca el `HOME` real.** Hay un test que lo vigila.
2. **Una aserción negativa necesita la prueba del caso positivo.** Afirmar que
   algo no aparece es inútil si nunca estuvo: es exactamente por lo que catorce
   tests del filtro de secretos daban cobertura falsa.
3. **Cómo delegar en subagentes** (sección «Si delegas en subagentes»): qué
   modelo para qué tarea, cuántos en paralelo, y por qué un validador recibe el
   hallazgo pero no el razonamiento. Las reglas salen de lo que falló en esta
   misma ronda: la cuota agotada dos veces, un `staging` mezclado por tres
   agentes sobre un solo árbol de trabajo, y los hooks reales del usuario
   sobrescritos por un aislamiento de entorno que no aislaba nada.

Y una lección sobre el método, que vale para la próxima: **una suite verde no
es evidencia**. De doce mutaciones introducidas a mano sobre el código, seis no
pusieron roja la suite. Las pruebas de mutación encontraron en una tarde más
huecos que los tests en meses, y son el único modo honesto de saber si una red
de seguridad existe o solo lo parece.

Y un matiz que costó caro aprender, al terminar las correcciones: **la ausencia
de fallo no prueba que un test sea débil**, igual que su presencia no prueba que
sea bueno. Una mutación que no pone rojo el test puede ser una reversión
parcial que deja vivo otro mecanismo tapando el defecto. Hay que verificar que
la mutación reproduce el defecto antes de juzgar el test.
