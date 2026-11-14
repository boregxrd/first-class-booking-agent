# Jira backlog

Backlog compartido de Manu y Félix (Bangfeal). Este archivo es la fuente de verdad del estado de estas tareas dentro del repositorio.

## Progreso

| Estado | Tareas |
|---|---:|
| Todo | 9 |
| In progress | 1 |
| Finished | 2 |

El estado y la verificación de cada tarea se reflejan en su sección y notas; las tareas en Todo siguen pendientes de verificación.

## Todo

| ID | Tarea | Responsable | Progreso / notas |
|---|---|---|---|
| 2 | Pulir el lenguaje del bot para que suene más natural. | Félix | Pendiente. |
| 4 | Enviar el mensaje de confirmación solo cuando la reserva esté confirmada. | Félix | Pendiente. |
| 6 | Conectar WhatsApp mediante el número de teléfono. | Manu | Pendiente. |
| 8 | Implementar soporte para varias cuentas con un contexto y calendario compartidos. | Manu | Pendiente. |
| 9 | Definir e implementar los perfiles de distribuidoras y su almacenamiento. | Manu | Pendiente. |
| 10 | Integrar los DMs de TikTok como canal de conversación, igual que WhatsApp e Instagram. | Por asignar | Pendiente. |
| 11 | Automatizar mensajes privados a partir de comentarios con palabras clave en Instagram. | Por asignar | Pendiente; dejar para el final. |
| 12 | Automatizar mensajes privados a partir de comentarios con palabras clave en TikTok. | Por asignar | Pendiente; dejar para el final. |

## In progress

| ID | Tarea | Responsable | Progreso / notas |
|---|---|---|---|
| 3 | Obtener el nombre desde Instagram. Si no consigue obtenerlo, pedir confirmación al usuario. | Manu | Inicio: 2026-11-14. Alcance: consultar el nombre del remitente mediante Instagram y pedir confirmación al usuario si no está disponible. Tarea iniciada en el backlog; implementación pendiente. |

## Finished

| ID | Tarea | Responsable | Resultado / verificación |
|---|---|---|---|
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
