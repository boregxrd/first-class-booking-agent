# Jira backlog

Backlog compartido de Manu y Félix (Bangfeal). Este archivo es la fuente de verdad del estado de estas tareas dentro del repositorio.

## Progreso

| Estado | Tareas |
|---|---:|
| Todo | 6 |
| In progress | 2 |
| Finished | 6 |

El estado y la verificación de cada tarea se reflejan en su sección y notas; las tareas en Todo siguen pendientes de verificación.

## Todo

| ID | Tarea | Responsable | Progreso / notas |
|---|---|---|---|
| 2 | Pulir el lenguaje del bot para que suene más natural. | Félix | Pendiente. |
| 4 | Enviar el mensaje de confirmación solo cuando la reserva esté confirmada. | Félix | Pendiente. |
| 6 | Conectar WhatsApp mediante el número de teléfono. | Manu | Pendiente. |
| 10 | Integrar los DMs de TikTok como canal de conversación, igual que WhatsApp e Instagram. | Félix | Pendiente. Asignada a Félix por Manu el 2026-11-14. |
| 11 | Automatizar mensajes privados a partir de comentarios con palabras clave en Instagram. | Por asignar | Pendiente; dejar para el final. |
| 12 | Automatizar mensajes privados a partir de comentarios con palabras clave en TikTok. | Por asignar | Pendiente; dejar para el final. |

## In progress

| ID | Tarea | Responsable | Progreso / notas |
|---|---|---|---|
| 14 | Implementar portal de onboarding, credenciales multicuenta y creación/compartición automática de calendarios. | Manu | Inicio: 2026-11-14. Código desplegado: portal /admin, acceso propietario verificado, vault AES-GCM/rotación, OAuth Google con PKCE y estado de un uso, Instagram con suscripción messages, creación/compartición recuperable e invitación Google. Incluye conexión de números WhatsApp Cloud API ya provisionados e interfaz para #10; no simula alta de un número Business ni permisos TikTok. Verificado con proveedores simulados y API propietaria real (401 sin autorización, overview/import autenticados). Añadidos mensajes de login/configuración e importador seguro del JSON OAuth Web. Cliente Google instalado en Cloudflare; tras añadir la cuenta del gimnasio como test user, consentimiento real completado y credencial cifrada google-owner confirmada en D1 el 2026-11-16 (22:10:47 UTC). Pendiente: primera distribuidora real para verificar creación, propiedad, permisos reader e invitación; configurar OAuth Instagram y validar conexión real. Ver docs/OWNER_PORTAL.md. |
| 8 | Implementar soporte para varias cuentas con contexto compartido y calendario de atribución por distribuidora. | Manu | Inicio: 2026-11-14. Implementado routing por cuenta, credenciales aisladas, atribución persistente, protección contra duplicados activos entre cuentas, recuperación/cancelación usando calendario guardado y selección explícita de WhatsApp del gimnasio. Suite completa: typecheck y 94 tests correctos; casos multicuenta con D1 real local y proveedores simulados. Migración 0007 aplicada y DWC importado; versión c4b7fc7d-cda0-4baa-a915-75869b0fab7b desplegada con MULTI_ACCOUNT_ENABLED=false. Pendiente: terminar autorización #14, conectar dos cuentas reales y verificar flujos antes de activar. Entrega WhatsApp y plantilla con cuenta de origen requieren #6/aprobación Meta. |

## Finished

| ID | Tarea | Responsable | Resultado / verificación |
|---|---|---|---|
| 9 | Definir e implementar los perfiles de distribuidoras y su almacenamiento. | Manu | Inicio y finalización: 2026-11-14. Perfiles mínimos nombre/email/activo con calendario ID/link/estado, sin kind/position/tier; DWC es un registro normal usando el calendario general existente. Cuentas sociales y credenciales cifradas separadas; reservas conservan distribuidora, cuenta y calendario de origen. Migración 0007 aplicada remotamente sin recrear calendarios; importación propietaria idempotente verificada en producción. Pruebas de validación, aislamiento, conservación de datos previos e idempotencia incluidas en suite de 94 tests; typecheck y build Worker correctos. Plan y criterios en docs/MULTI_ACCOUNT_PLAN.md. |
| 3 | Obtener el nombre desde Instagram. Si no consigue obtenerlo, pedir confirmación al usuario. | Manu | Inicio y finalización: 2026-11-14. Implementado lookup por sender ID con timeout/caché, username automático y nombre de perfil separado del confirmado; se solicita confirmar/corregir el nombre sin pedir el handle. Migración 0005 aplicada; pruebas locales de persistencia, alias, confirmación y fallo del lookup incluidas en la suite de 78 tests correctos del PR #5. Tras una primera consulta sin datos, Manu repitió la prueba real en @dwctesthello y confirmó que funcionó. Fallback vigente según #13: pedir teléfono y solo usar un handle real conocido si la persona declara no tener teléfono/WhatsApp. |
| 13 | Corregir el flujo de reserva tras la prueba real: bienvenida breve, día y hora explícitos, política de clases para mujeres, teléfono para WhatsApp y resumen corto. | Manu | Inicio y finalización: 2026-11-14. Implementadas selección persistente de día/hora solo desde texto de la persona, guardas contra fechas inferidas y domingos cerrados, nombre suministrado/confirmado, teléfono obligatorio salvo ausencia explícita más handle real conocido, bienvenida breve, política sin ofrecer cambiar el nombre y resumen corto con “sí/yes” y consentimiento WhatsApp. Corregidas repreguntas tras recibir el nombre/teléfono. Verificación: typecheck, 78/78 tests, validación de sintaxis del cliente y smoke real en chat protegido hasta resumen pendiente de confirmación (sin crear reserva real). Migración 0006 aplicada; versión 9a149a5c-a07d-4607-8094-7cf22c31499a desplegada. Integrados y conservados los cambios de elegibilidad de Félix tras git pull. La incidencia de consulta de perfil permanece separada en #3. |
| 5 | Buscar al usuario en el calendario hasta un mes atrás para comprobar si ya tuvo una primera clase. | Félix | Finalizada 2026-11-14. D1 bloquea otra propuesta/reserva si encuentra una reserva confirmada en los 30 días anteriores para el mismo customer, teléfono exacto o handle de Instagram (sin distinguir mayúsculas); canceladas/fallidas y reservas fuera del intervalo no cuentan. Typecheck y 53 pruebas pasan. No se buscan eventos históricos externos que no estén registrados en D1; el registro confirma reserva, no asistencia. |
| 7 | Programar recordatorios por WhatsApp 24 horas y 1 hora antes de la clase, si es posible. | Félix | Finalizada 2026-11-14. Añadidos recordatorios WhatsApp de 24 h y 1 h con opt-in y número; se omiten avisos cuyo horario ya pasó y ambos usan la plantilla configurada. Typecheck y 50 pruebas pasan; entrega real pendiente de la configuración WhatsApp de la tarea #6. |
| 1 | Investigar por qué el bot no responde a algunas personas en Instagram, especialmente a quienes la cuenta no sigue. | Manu | Inicio y finalización: 2026-11-14. Causa identificada: modo test restringido al sender 1078653611459615; los demás remitentes se observaban sin procesar. A petición del usuario, cambiado `META_MESSAGING_MODE` a `live` y desplegada versión `d8cbbf28-14d8-4773-9115-37111780fd7a`, eliminando la restricción. Verificación: typecheck correcto, 48/48 tests correctos, Worker HTTP 200, cola con productor/consumidor, cron sin excepciones y D1 sin alertas abiertas ni mensajes pendientes/fallidos durante la revisión. El usuario confirmó que un amigo envió un DM y recibió respuesta tras el cambio. Cuenta receptora documentada: @dwctesthello. No se confirmó si esa cuenta sigue al amigo; la aplicación ya no filtra por remitente ni por relación de seguimiento. |

## Cómo mantenerlo actualizado

- Antes de trabajar, revisar este archivo y localizar la tarea correspondiente.
- Al empezar una tarea, mover su fila de **Todo** a **In progress** y anotar la fecha de inicio (`YYYY-MM-DD`) y el alcance del trabajo.
- Actualizar las notas conforme haya avances o bloqueos. Una tarea bloqueada o parcialmente implementada permanece en **In progress**, indicando qué falta.
- Al terminar y verificar el trabajo, mover la fila a **Finished** y registrar la fecha de finalización, el resultado y la verificación realizada.
- Conservar los IDs y responsables acordados al mover las filas; no duplicarlas ni renumerarlas.
- Actualizar los contadores de **Progreso** con cada cambio de estado.
- Si se acuerda trabajo nuevo fuera de estas tareas, añadirlo con un ID nuevo y responsable conocido o `Por asignar`.
- Este archivo es un seguimiento local; no implica que existan tickets sincronizados en Jira.
