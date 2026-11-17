# Jira backlog

Backlog compartido de Manu y Félix (Bangfeal). Este archivo es la fuente de verdad del estado de estas tareas dentro del repositorio.

## Progreso

| Estado | Tareas |
|---|---:|
| Todo | 6 |
| In progress | 3 |
| Finished | 6 |

El estado y la verificación de cada tarea se reflejan en su sección y notas; las tareas en Todo siguen pendientes de verificación.

## Todo

| ID | Tarea | Responsable | Progreso / notas |
|---|---|---|---|
| 15 | Preparar y tramitar acceso Meta para conectar cuentas profesionales externas sin alta manual como testers. | Manu | Inicio: 2026-11-17. Acordado con el usuario. Permisos business_basic y business_manage_messages aparecen Ready for testing, 0 llamadas; no acredita aprobación pública. Paquete de justificaciones, demo e instrucciones preparado en docs/META_APP_REVIEW.md y comentario de PR #6. Políticas públicas actualizadas a onboarding/Gmail/retención, verificadas tras desplegar 5ac727f1-02f1-44ba-805e-6a56a3451ca3; fuente firmada en dc082cb al reintentar. Añadir/aceptar cuenta profesional como Instagram Tester en paralelo para #14. No enviado a Meta: faltan demo funcional, acceso de revisor y requisitos exactos del formulario. |
| 2 | Pulir el lenguaje del bot para que suene más natural. | Félix | Pendiente. |
| 4 | Enviar el mensaje de confirmación solo cuando la reserva esté confirmada. | Félix | Pendiente. |
| 6 | Conectar WhatsApp mediante el número de teléfono. | Manu | Pendiente. |
| 10 | Integrar los DMs de TikTok como canal de conversación, igual que WhatsApp e Instagram. | Félix | Pendiente. Asignada a Félix por Manu el 2026-11-14. |
| 11 | Automatizar mensajes privados a partir de comentarios con palabras clave en Instagram. | Por asignar | Pendiente; dejar para el final. |
| 12 | Automatizar mensajes privados a partir de comentarios con palabras clave en TikTok. | Por asignar | Pendiente; dejar para el final. |

## In progress

| ID | Tarea | Responsable | Progreso / notas |
|---|---|---|---|
| 14 | Implementar portal de onboarding, credenciales multicuenta y creación/compartición automática de calendarios. | Manu | Inicio: 2026-11-14. Google/calendario y Gmail verificados. Tras aceptar la invitación de Instagram Tester, nueva autorización completó token largo, identidad, suscripción messages y guardado: cuenta profesional vinculada a dinosaurio y su calendario; expiración real 2027-01-16T09:53:14.205Z. Antes, consentimiento de ambas permissions con rol pendiente producía HTTP 400/código 100 Unsupported request. Último intento exitoso confirmado en servidor; alertas históricas del perfil resueltas conservando diagnóstico. Guardas, cifrado y checkpoints mantienen su función. Pendientes pruebas de mensajería/lifecycle y demo real para revisión; no implica acceso público aprobado (#15). Typecheck/110 tests correctos, #14 en curso. |
| 8 | Implementar soporte para varias cuentas con contexto compartido y calendario de atribución por distribuidora. | Manu | Inicio: 2026-11-14. Routing, credenciales aisladas, atribución persistente, prevención de duplicados, recuperación/cancelación por calendario guardado y WhatsApp central implementados; typecheck/110 tests correctos con pipeline completo simulado. DWC y cuenta profesional de dinosaurio registrados/connected. MULTI_ACCOUNT_ENABLED=true para prueba real controlada de los registros activos; versión 16e99117-fe03-4487-8cfb-de5755b3f241. Pendiente DM desde otra cuenta, respuesta por origen, reserva confirmada en calendario dinosaurio y comparación con calendario general; luego lifecycle/cambios/cancelación. WhatsApp sigue deshabilitado (#6/plantillas); acceso externo general requiere #15, TikTok #10. Handoff en docs/MULTI_ACCOUNT_HANDOFF.md. |

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
