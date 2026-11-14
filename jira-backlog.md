# Jira backlog

Backlog compartido de Manu y Félix (Bangfeal). Este archivo es la fuente de verdad del estado de estas tareas dentro del repositorio.

## Progreso

| Estado | Tareas |
|---|---:|
| Todo | 11 |
| In progress | 0 |
| Finished | 1 |

El estado y la verificación de cada tarea se reflejan en su sección y notas; las tareas en Todo siguen pendientes de verificación.

## Todo

| ID | Tarea | Responsable | Progreso / notas |
|---|---|---|---|
| 1 | Investigar por qué el bot no responde a algunas personas en Instagram, especialmente a quienes la cuenta no sigue. | Manu | Pendiente. |
| 2 | Pulir el lenguaje del bot para que suene más natural. | Félix | Pendiente. |
| 3 | Obtener el nombre desde Instagram. Si no consigue obtenerlo, pedir confirmación al usuario. | Manu | Pendiente. |
| 4 | Enviar el mensaje de confirmación solo cuando la reserva esté confirmada. | Félix | Pendiente. |
| 5 | Buscar al usuario en el calendario hasta un mes atrás para comprobar si ya tuvo una primera clase. | Félix | Pendiente. |
| 6 | Conectar WhatsApp mediante el número de teléfono. | Manu | Pendiente. |
| 8 | Implementar soporte para varias cuentas con un contexto y calendario compartidos. | Manu | Pendiente. |
| 9 | Definir e implementar los perfiles de distribuidoras y su almacenamiento. | Manu | Pendiente. |
| 10 | Integrar los DMs de TikTok como canal de conversación, igual que WhatsApp e Instagram. | Por asignar | Pendiente. |
| 11 | Automatizar mensajes privados a partir de comentarios con palabras clave en Instagram. | Por asignar | Pendiente; dejar para el final. |
| 12 | Automatizar mensajes privados a partir de comentarios con palabras clave en TikTok. | Por asignar | Pendiente; dejar para el final. |

## In progress

| ID | Tarea | Responsable | Progreso / notas |
|---|---|---|---|

## Finished

| ID | Tarea | Responsable | Resultado / verificación |
|---|---|---|---|
| 7 | Programar recordatorios por WhatsApp 24 horas y 1 hora antes de la clase, si es posible. | Félix | Finalizada 2026-11-14. Añadidos recordatorios WhatsApp de 24 h y 1 h con opt-in y número; se omiten avisos cuyo horario ya pasó y ambos usan la plantilla configurada. Typecheck y 50 pruebas pasan; entrega real pendiente de la configuración WhatsApp de la tarea #6. |

## Cómo mantenerlo actualizado

- Antes de trabajar, revisar este archivo y localizar la tarea correspondiente.
- Al empezar una tarea, mover su fila de **Todo** a **In progress** y anotar la fecha de inicio (`YYYY-MM-DD`) y el alcance del trabajo.
- Actualizar las notas conforme haya avances o bloqueos. Una tarea bloqueada o parcialmente implementada permanece en **In progress**, indicando qué falta.
- Al terminar y verificar el trabajo, mover la fila a **Finished** y registrar la fecha de finalización, el resultado y la verificación realizada.
- Conservar los IDs y responsables acordados al mover las filas; no duplicarlas ni renumerarlas.
- Actualizar los contadores de **Progreso** con cada cambio de estado.
- Si se acuerda trabajo nuevo fuera de estas tareas, añadirlo con un ID nuevo y responsable conocido o `Por asignar`.
- Este archivo es un seguimiento local; no implica que existan tickets sincronizados en Jira.
