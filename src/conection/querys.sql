USE registro_usuarios_evento;
SELECT * FROM conferencias;

SELECT  * FROM eventos where id =1 ;

SELECT * FROM conferencias;

SELECT e.id, e.nombre, e.codigo
FROM estados e
INNER JOIN conferencia_estado ce ON e.id = ce.estado_id
WHERE ce.conferencia_id = 7;