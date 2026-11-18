/* ======================================================
   KantoTech — Guante Traductor
   Conexión Bluetooth (Web Bluetooth API) + lógica de UI
====================================================== */

/* --------------------------------------------------------
   1) CONFIGURÁ ACÁ LOS UUID DE TU ESP32
   Por defecto están los del servicio UART de Nordic (NUS),
   que es el que usan la mayoría de las librerías BLE de
   ESP32 (ej. BLESerial). Si tu firmware usa otros UUID de
   servicio/característica, reemplazalos acá.
-------------------------------------------------------- */
const CONFIG_BLE = {
    servicio:        "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // UART Service
    caracteristicaTX: "6e400003-b5a3-f393-e0a9-e50e24dcca9e", // Notify (ESP32 -> web)
    caracteristicaRX: "6e400002-b5a3-f393-e0a9-e50e24dcca9e", // Write   (web -> ESP32), opcional
    nombreDispositivo: "" // Ej: "KantoGuante" si querés filtrar por nombre en vez de servicio
};

/* --------------------------------------------------------
   2) ESTADO
-------------------------------------------------------- */
const estado = {
    dispositivo: null,
    caracteristicaTX: null,
    caracteristicaRX: null,
    ultimaLetraCruda: "",
    ultimaLetraConfirmada: "",
    temporizadorEstabilidad: null,
    oracion: [], // array de { tipo: 'letra' | 'espacio', valor }
    ultimaLecturaSensor: [null, null, null, null, null], // timestamp del último dato de cada dedo
    biblioteca: [] // señas guardadas en el guante: { nombre, movimiento, defecto }
};

const NOMBRES_DEDOS = ["Pulgar", "Índice", "Medio", "Anular", "Meñique"];
const MS_ESTABILIDAD = 550; // tiempo que una letra debe mantenerse para confirmarse en la cinta
const MS_LIMITE_SENSOR = 2500; // si un dedo no manda dato en este tiempo, se marca "sin lectura"

/* --------------------------------------------------------
   3) REFERENCIAS DEL DOM
-------------------------------------------------------- */
const btnBluetooth   = document.getElementById("btnBluetooth");
const btEstadoTexto   = document.getElementById("btEstadoTexto");
const estadoGrande    = document.getElementById("estadoGrande");
const nombreDispositivoEl = document.getElementById("nombreDispositivo");
const letraActualEl   = document.getElementById("letraActual");
const cinta           = document.getElementById("cinta");
const cintaCursor     = document.getElementById("cintaCursor");

document.getElementById("btnEspacio").addEventListener("click", () => agregarEspacio());
document.getElementById("btnBorrarLetra").addEventListener("click", () => borrarUltima());
document.getElementById("btnLimpiar").addEventListener("click", () => limpiarTodo());
document.getElementById("btnCopiar").addEventListener("click", () => copiarOracion());

btnBluetooth.addEventListener("click", () => {
    if (estado.dispositivo && estado.dispositivo.gatt.connected) {
        estado.dispositivo.gatt.disconnect();
    } else {
        conectarGuante();
    }
});

/* --------------------------------------------------------
   4b) MENÚ DE CONFIGURACIÓN (modo oscuro + calibración)
-------------------------------------------------------- */
const btnConfig = document.getElementById("btnConfig");
const panelConfig = document.getElementById("panelConfig");
const chkModoOscuro = document.getElementById("chkModoOscuro");
const pantallas = document.querySelectorAll(".pantalla");

function cerrarMenuConfig() {
    panelConfig.classList.add("oculto");
    btnConfig.classList.remove("activo");
    btnConfig.setAttribute("aria-expanded", "false");
}

// Muestra una sola pantalla y oculta las demás
function mostrarPantalla(id) {
    pantallas.forEach(p => p.classList.toggle("oculto", p.id !== id));
    cerrarMenuConfig();
    if (id !== "pantallaVerificacion") salirModoAislado();
    window.scrollTo({ top: 0 });
}

btnConfig.addEventListener("click", (evento) => {
    evento.stopPropagation();
    const abierto = panelConfig.classList.toggle("oculto") === false;
    btnConfig.classList.toggle("activo", abierto);
    btnConfig.setAttribute("aria-expanded", abierto);
});

document.addEventListener("click", (evento) => {
    if (!panelConfig.contains(evento.target) && evento.target !== btnConfig) {
        panelConfig.classList.add("oculto");
        btnConfig.classList.remove("activo");
        btnConfig.setAttribute("aria-expanded", "false");
    }
});

// Modo oscuro: se recuerda entre visitas con localStorage
const modoOscuroGuardado = localStorage.getItem("kantotech-modo-oscuro") === "true";
aplicarModoOscuro(modoOscuroGuardado);
chkModoOscuro.checked = modoOscuroGuardado;

chkModoOscuro.addEventListener("change", () => {
    aplicarModoOscuro(chkModoOscuro.checked);
    localStorage.setItem("kantotech-modo-oscuro", chkModoOscuro.checked);
});

function aplicarModoOscuro(activo) {
    document.documentElement.setAttribute("data-tema", activo ? "oscuro" : "claro");

    // que la barra superior del celular (modo app instalada) combine con el tema
    const metaTema = document.querySelector('meta[name="theme-color"]');
    if (metaTema) metaTema.setAttribute("content", activo ? "#2f5d8b" : "#e14778");
}

// Verificación y calibración de sensores: cada una es una pantalla aparte
document.getElementById("btnAbrirVerificacion").addEventListener("click", () => mostrarPantalla("pantallaVerificacion"));
document.getElementById("btnAbrirCalibracion").addEventListener("click", () => mostrarPantalla("pantallaCalibracion"));
document.getElementById("btnVolverVerificacion").addEventListener("click", () => mostrarPantalla("pantallaPrincipal"));
document.getElementById("btnVolverCalibracion").addEventListener("click", () => mostrarPantalla("pantallaPrincipal"));

// Botón "Verificar" de cada tarjeta: resalta ese sensor y atenúa los demás,
// para poder mover un solo dedo por vez sin que los otros 4 números
// cambiando al mismo tiempo hagan confuso saber cuál es cuál.
const grillaSensoresEl = document.getElementById("grillaSensores");

document.querySelectorAll(".btn-verificar").forEach(boton => {
    boton.addEventListener("click", () => {
        const tarjeta = boton.closest(".sensor-tarjeta");
        const yaActiva = tarjeta.classList.contains("verificando");

        if (yaActiva) {
            salirModoAislado();
        } else {
            document.querySelectorAll(".sensor-tarjeta").forEach(t => t.classList.remove("verificando"));
            document.querySelectorAll(".btn-verificar").forEach(b => b.textContent = "Verificar");

            tarjeta.classList.add("verificando");
            boton.textContent = "Dejar de verificar";
            grillaSensoresEl.classList.add("modo-aislado");
        }
    });
});

function salirModoAislado() {
    grillaSensoresEl.classList.remove("modo-aislado");
    document.querySelectorAll(".sensor-tarjeta").forEach(t => t.classList.remove("verificando"));
    document.querySelectorAll(".btn-verificar").forEach(b => b.textContent = "Verificar");
}

/* --------------------------------------------------------
   4) CONEXIÓN BLUETOOTH
-------------------------------------------------------- */
async function conectarGuante() {
    if (!navigator.bluetooth) {
        alert("Este navegador no soporta Web Bluetooth. Probá con Chrome o Edge, y que la página esté en HTTPS (o localhost).");
        return;
    }

    try {
        actualizarEstadoConexion("buscando");

        const opciones = CONFIG_BLE.nombreDispositivo
            ? { filters: [{ name: CONFIG_BLE.nombreDispositivo }], optionalServices: [CONFIG_BLE.servicio] }
            : { filters: [{ services: [CONFIG_BLE.servicio] }] };

        const dispositivo = await navigator.bluetooth.requestDevice(opciones);
        estado.dispositivo = dispositivo;
        dispositivo.addEventListener("gattserverdisconnected", alDesconectar);

        const servidor = await dispositivo.gatt.connect();
        const servicio = await servidor.getPrimaryService(CONFIG_BLE.servicio);

        estado.caracteristicaTX = await servicio.getCharacteristic(CONFIG_BLE.caracteristicaTX);
        await estado.caracteristicaTX.startNotifications();
        estado.caracteristicaTX.addEventListener("characteristicvaluechanged", alRecibirDatos);

        try {
            estado.caracteristicaRX = await servicio.getCharacteristic(CONFIG_BLE.caracteristicaRX);
        } catch (_) {
            estado.caracteristicaRX = null; // opcional, no todos los firmwares lo necesitan
        }

        actualizarEstadoConexion("conectado", dispositivo.name);

        // Al conectar, se le pide al guante su biblioteca de señas guardadas
        pedirBiblioteca().catch(() => {});

    } catch (error) {
        console.error("No se pudo conectar:", error);
        actualizarEstadoConexion("desconectado");
        if (error.name !== "NotFoundError") {
            alert("No se pudo conectar con el guante. Revisá que esté encendido y en modo de emparejamiento.");
        }
    }
}

function alDesconectar() {
    estado.caracteristicaRX = null;
    estado.biblioteca = [];
    actualizarEstadoConexion("desconectado");
    estado.ultimaLecturaSensor = [null, null, null, null, null];
    document.querySelectorAll(".sensor-tarjeta").forEach(marcarSensorError);
    calibracionPerdioConexion();
}

function actualizarEstadoConexion(tipo, nombre = "") {
    if (tipo === "conectado") {
        btnBluetooth.classList.add("conectado");
        btEstadoTexto.textContent = "Guante conectado";
        estadoGrande.textContent = "Conectado";
        estadoGrande.classList.add("conectado");
        nombreDispositivoEl.textContent = nombre ? `· ${nombre}` : "";
    } else if (tipo === "buscando") {
        btnBluetooth.classList.remove("conectado");
        btEstadoTexto.textContent = "Buscando…";
        estadoGrande.textContent = "Buscando dispositivo";
        estadoGrande.classList.remove("conectado");
        nombreDispositivoEl.textContent = "";
    } else {
        btnBluetooth.classList.remove("conectado");
        btEstadoTexto.textContent = "Conectar guante";
        estadoGrande.textContent = "Desconectado";
        estadoGrande.classList.remove("conectado");
        nombreDispositivoEl.textContent = "";
    }
    actualizarUICalibracion();
}

/* --------------------------------------------------------
   5) RECEPCIÓN DE DATOS DEL ESP32
   Se espera idealmente JSON, por ejemplo:
   {"flex":[80,20,15,10,5],"letra":"A"}
   Si el ESP32 manda solo texto plano (ej. una letra suelta),
   también funciona: se toma como la letra detectada.
-------------------------------------------------------- */
function alRecibirDatos(evento) {
    const texto = new TextDecoder().decode(evento.target.value).trim();
    if (!texto) return;

    let letra = "";
    let sensores = null;

    try {
        const datos = JSON.parse(texto);

        // Mensajes de la biblioteca / calibración (traen "ev"): no son lecturas de sensores
        if (datos.ev) {
            procesarEventoGuante(datos);
            return;
        }

        letra = (datos.letra ?? datos.letter ?? datos.l ?? "").toString().toUpperCase();
        sensores = datos.flex ?? datos.sensores ?? datos.dedos ?? null;
    } catch (_) {
        // un JSON cortado a mitad de camino no es una letra: se descarta
        if (texto.startsWith("{")) return;
        // no era JSON: tratamos el texto recibido directamente como la letra
        letra = texto.toUpperCase();
    }

    if (sensores) actualizarSensores(sensores);
    if (letra) procesarLetraDetectada(letra);
}

function actualizarSensores(valores) {
    const tarjetas = document.querySelectorAll(".sensor-tarjeta");
    const ahora = Date.now();

    tarjetas.forEach((tarjeta, i) => {
        const crudo = valores[i];

        // sin dato para este dedo en el paquete recibido -> error
        if (crudo === undefined || crudo === null || crudo === "" || Number.isNaN(Number(crudo))) {
            marcarSensorError(tarjeta);
            return;
        }

        marcarSensorOk(tarjeta, Math.round(Number(crudo)));
        estado.ultimaLecturaSensor[i] = ahora;
    });
}

function marcarSensorOk(tarjeta, valorCrudo) {
    tarjeta.classList.remove("error");
    tarjeta.querySelector(".sensor-valor-crudo").textContent = valorCrudo;
}

function marcarSensorError(tarjeta) {
    tarjeta.classList.add("error");
}

/* Revisa periódicamente si algún dedo dejó de mandar datos
   (por ejemplo, un sensor desconectado del guante) y lo marca
   con el mensaje de error, aunque los demás sigan llegando bien. */
setInterval(() => {
    if (!estado.dispositivo || !estado.dispositivo.gatt.connected) return;

    const tarjetas = document.querySelectorAll(".sensor-tarjeta");
    const ahora = Date.now();

    tarjetas.forEach((tarjeta, i) => {
        const ultima = estado.ultimaLecturaSensor[i];
        if (ultima === null || (ahora - ultima) > MS_LIMITE_SENSOR) {
            marcarSensorError(tarjeta);
        }
    });
}, 1000);

/* --------------------------------------------------------
   6) LÓGICA DE LETRA -> ORACIÓN
   Para que el guante no repita la misma letra en cada
   paquete BLE, sólo se confirma una letra en el renglón
   cuando se mantiene estable un ratito (MS_ESTABILIDAD).
-------------------------------------------------------- */
// Qué mostrar como imagen para cada seña reconocida. Vacío por ahora:
// cuando calibres y tengas tus propias imágenes, poné los archivos en
// imagenes/ (ej. imagenes/piedra.png) y agregalos acá así:
// "PIEDRA": "imagenes/piedra.png",
const IMAGENES_SEÑA = {
    "PIEDRA":  "",
    "PAPEL":   "",
    "TIJERAS": "",
    "HOLA":    ""
};

// true  = si la seña tiene imagen, se muestra SOLO la imagen (sin la palabra).
// false = se muestra la imagen y también la palabra.
// Las señas que NO tienen imagen cargada siguen mostrando la palabra igual.
const MOSTRAR_SOLO_IMAGEN = true;

function esArchivoDeImagen(contenido) {
    return /\.(png|jpg|jpeg|svg|webp|gif)$/i.test(contenido);
}

function actualizarImagenSeña(letra) {
    const contenido = IMAGENES_SEÑA[letra];
    const imagenEl = document.getElementById("imagenSeña");
    const cajaEl = imagenEl.closest(".letra-actual-caja");

    imagenEl.innerHTML = "";
    cajaEl.classList.remove("solo-imagen");

    if (!contenido) return;

    const ocultarPalabra = () => {
        if (MOSTRAR_SOLO_IMAGEN) cajaEl.classList.add("solo-imagen");
    };

    if (esArchivoDeImagen(contenido)) {
        const img = document.createElement("img");
        img.alt = letra;
        // si el archivo no carga (ruta o nombre mal escrito), se vuelve a
        // mostrar la palabra para que no quede la pantalla vacía
        img.onerror = () => {
            imagenEl.innerHTML = "";
            cajaEl.classList.remove("solo-imagen");
        };
        img.src = contenido;
        imagenEl.appendChild(img);
        ocultarPalabra();
    } else {
        // no es un archivo: se asume emoji o texto corto
        imagenEl.textContent = contenido;
        ocultarPalabra();
    }
}

function procesarLetraDetectada(letra) {
    letraActualEl.textContent = letra || "–";
    actualizarImagenSeña(letra);

    if (letra === estado.ultimaLetraCruda) return;
    estado.ultimaLetraCruda = letra;

    clearTimeout(estado.temporizadorEstabilidad);
    estado.temporizadorEstabilidad = setTimeout(() => {
        if (letra && letra !== estado.ultimaLetraConfirmada) {
            agregarLetra(letra);
        }
        estado.ultimaLetraConfirmada = letra;
    }, MS_ESTABILIDAD);
}

/* --------------------------------------------------------
   7) MANEJO DE LA CINTA / ORACIÓN
-------------------------------------------------------- */
function agregarLetra(letra) {
    estado.oracion.push({ tipo: "letra", valor: letra });
    renderizarCinta();
}

function agregarEspacio() {
    if (estado.oracion.length === 0) return;
    estado.oracion.push({ tipo: "espacio", valor: " " });
    renderizarCinta();
}

function borrarUltima() {
    estado.oracion.pop();
    renderizarCinta();
}

function limpiarTodo() {
    estado.oracion = [];
    renderizarCinta();
}

function copiarOracion() {
    const texto = estado.oracion.map(t => t.valor).join("");
    if (!texto) return;
    navigator.clipboard.writeText(texto).then(() => {
        const original = "Copiar oración";
        const boton = document.getElementById("btnCopiar");
        boton.textContent = "¡Copiado!";
        setTimeout(() => (boton.textContent = original), 1200);
    });
}

function renderizarCinta() {
    cinta.innerHTML = "";
    estado.oracion.forEach(item => {
        const span = document.createElement("span");
        span.className = item.tipo === "espacio" ? "cinta-letra espacio" : "cinta-letra";

        const contenido = item.tipo === "letra" ? IMAGENES_SEÑA[item.valor] : "";

        if (MOSTRAR_SOLO_IMAGEN && contenido && esArchivoDeImagen(contenido)) {
            span.classList.add("con-imagen");
            const img = document.createElement("img");
            img.alt = item.valor;
            // si la imagen no carga, la ficha vuelve a mostrar la palabra
            img.onerror = () => {
                span.classList.remove("con-imagen");
                span.textContent = item.valor;
            };
            img.src = contenido;
            span.appendChild(img);
        } else if (MOSTRAR_SOLO_IMAGEN && contenido) {
            span.textContent = contenido; // emoji
        } else {
            span.textContent = item.tipo === "espacio" ? "" : item.valor;
        }
        cinta.appendChild(span);
    });
    cinta.appendChild(cintaCursor);
    cinta.parentElement.scrollLeft = cinta.parentElement.scrollWidth;
}

/* --------------------------------------------------------
   8) CALIBRACIÓN DE SEÑAS DESDE LA PÁGINA
   Las señas se guardan en la memoria flash del propio guante (ESP32),
   no en la página: la biblioteca viaja con el producto y no hace falta
   cuenta ni internet. La página solo manda comandos por la
   característica RX (texto plano) y muestra lo que el guante responde:

     CAL|NOMBRE|M   calibrar (M = 0 mano quieta, 1 con movimiento)
     LIST           pedir la biblioteca
     DEL|NOMBRE     borrar una seña del usuario

   El guante responde por TX con JSON que trae la clave "ev":
     lista / sena / progreso / calibrado / borrado / error
-------------------------------------------------------- */
const MUESTRAS_CALIBRACION = 10;     // debe coincidir con el firmware
const SEGUNDOS_PREPARACION = 3;      // cuenta atrás antes de empezar a medir
const MS_ESPERA_RESPUESTA = 5000;    // si el guante no da señales en este tiempo, se avisa
const MAX_CARACTERES_NOMBRE = 12;
const MAX_BYTES_NOMBRE = 23;         // el firmware guarda hasta 23 bytes (UTF-8)

const btnAgregarSena = document.getElementById("btnAgregarSena");
const avisoSinConexion = document.getElementById("avisoSinConexion");
const avisoBiblioteca = document.getElementById("avisoBiblioteca");
const bibliotecaVacia = document.getElementById("bibliotecaVacia");
const listaBiblioteca = document.getElementById("listaBiblioteca");

const modalCal = document.getElementById("modalCalibracion");
const calPasos = {
    form: document.getElementById("calPasoForm"),
    espera: document.getElementById("calPasoEspera"),
    resultado: document.getElementById("calPasoResultado")
};
const calNombre = document.getElementById("calNombre");
const calErrorForm = document.getElementById("calErrorForm");
const calCuentaAtras = document.getElementById("calCuentaAtras");
const calInstruccion = document.getElementById("calInstruccion");
const calProgresoCaja = document.getElementById("calProgresoCaja");
const calBarra = document.getElementById("calBarra");
const calBarraRelleno = document.getElementById("calBarraRelleno");
const calContador = document.getElementById("calContador");
const calBotonesEspera = document.getElementById("calBotonesEspera");
const calResultadoIcono = document.getElementById("calResultadoIcono");
const calResultadoTexto = document.getElementById("calResultadoTexto");
const calReintentar = document.getElementById("calReintentar");

const cal = {
    paso: "cerrado",     // cerrado | form | espera | resultado
    midiendo: false,     // true desde que se mandó el comando hasta que el guante termina
    nombre: "",
    movimiento: false,
    temporizador: null,  // cuenta atrás
    vigilante: null      // detecta que el guante no responde
};

let temporizadorAvisoBiblioteca = null;

function guanteListoParaComandos() {
    return !!(estado.dispositivo && estado.dispositivo.gatt.connected && estado.caracteristicaRX);
}

async function enviarComando(texto) {
    if (!guanteListoParaComandos()) throw new Error("Sin conexión con el guante");
    const datos = new TextEncoder().encode(texto);
    const rx = estado.caracteristicaRX;
    if (rx.writeValueWithResponse) await rx.writeValueWithResponse(datos);
    else await rx.writeValue(datos);
}

function pedirBiblioteca() {
    return enviarComando("LIST");
}

const TEXTOS_ERROR_GUANTE = {
    nombre:   "El nombre no es válido.",
    mpu:      "El guante no detecta el sensor de movimiento (MPU6050). Revisá el cableado o elegí «Mano quieta».",
    lleno:    "La biblioteca del guante está llena. Borrá alguna seña para poder agregar otra.",
    sinmov:   "No se detectó movimiento. Intentá de nuevo y hacé el movimiento completo mientras el guante mide.",
    defecto:  "Las señas de fábrica no se pueden borrar. Si querés cambiarla, calibrala de nuevo con el mismo nombre.",
    noexiste: "Esa seña ya no está en el guante.",
    timeout:  "El guante no respondió. Revisá la conexión e intentá de nuevo.",
    envio:    "No se pudo enviar la orden al guante. Revisá la conexión e intentá de nuevo.",
    conexion: "Se perdió la conexión con el guante."
};

function textoErrorGuante(codigo) {
    return TEXTOS_ERROR_GUANTE[codigo] || "El guante devolvió un error. Intentá de nuevo.";
}

/* ---------- Eventos que llegan del guante ---------- */
function procesarEventoGuante(d) {
    switch (d.ev) {
        case "lista":
            estado.biblioteca = [];
            renderizarBiblioteca();
            break;

        case "sena":
            if (typeof d.n === "string") {
                estado.biblioteca.push({ nombre: d.n, movimiento: !!d.m, defecto: !!d.d });
                renderizarBiblioteca();
            }
            break;

        case "progreso":
            calibracionProgreso(Number(d.n) || 0, Number(d.t) || MUESTRAS_CALIBRACION);
            break;

        case "calibrado":
            calibracionTerminada(d);
            pedirBiblioteca().catch(() => {});
            break;

        case "borrado":
            mostrarAvisoBiblioteca(`Se borró la seña «${d.n}».`);
            pedirBiblioteca().catch(() => {});
            break;

        case "error":
            if (cal.paso === "espera") calibracionError(d.c);
            else mostrarAvisoBiblioteca(textoErrorGuante(d.c));
            break;
    }
}

/* ---------- Pantalla de calibración: botón, avisos y biblioteca ---------- */
function actualizarUICalibracion() {
    const listo = guanteListoParaComandos();
    btnAgregarSena.disabled = !listo;
    avisoSinConexion.hidden = listo;
    renderizarBiblioteca();
}

function mostrarAvisoBiblioteca(texto) {
    avisoBiblioteca.textContent = texto;
    avisoBiblioteca.hidden = false;
    clearTimeout(temporizadorAvisoBiblioteca);
    temporizadorAvisoBiblioteca = setTimeout(() => { avisoBiblioteca.hidden = true; }, 6000);
}

function renderizarBiblioteca() {
    listaBiblioteca.innerHTML = "";

    if (!guanteListoParaComandos()) {
        bibliotecaVacia.textContent = "Conectá el guante para ver las señas guardadas.";
        bibliotecaVacia.hidden = false;
        return;
    }
    if (estado.biblioteca.length === 0) {
        bibliotecaVacia.textContent = "Todavía no hay señas para mostrar.";
        bibliotecaVacia.hidden = false;
        return;
    }
    bibliotecaVacia.hidden = true;

    // primero las del usuario (A-Z) y después las de fábrica
    const ordenadas = [...estado.biblioteca].sort((a, b) =>
        (a.defecto - b.defecto) || a.nombre.localeCompare(b.nombre, "es"));

    ordenadas.forEach(sena => {
        const li = document.createElement("li");
        li.className = "biblioteca-item";

        const nombre = document.createElement("span");
        nombre.className = "biblioteca-nombre";
        nombre.textContent = sena.nombre; // textContent: el nombre viene del guante, no se interpreta como HTML

        const etiquetas = document.createElement("span");
        etiquetas.className = "biblioteca-etiquetas";

        const tipo = document.createElement("span");
        tipo.className = "etiqueta";
        tipo.textContent = sena.movimiento ? "Con movimiento" : "Mano quieta";
        etiquetas.appendChild(tipo);

        if (sena.defecto) {
            const fabrica = document.createElement("span");
            fabrica.className = "etiqueta etiqueta-fabrica";
            fabrica.textContent = "De fábrica";
            etiquetas.appendChild(fabrica);
        }

        li.appendChild(nombre);
        li.appendChild(etiquetas);

        if (!sena.defecto) {
            const borrar = document.createElement("button");
            borrar.className = "btn-borrar-sena";
            borrar.type = "button";
            borrar.textContent = "Borrar";
            borrar.setAttribute("aria-label", `Borrar la seña ${sena.nombre}`);
            borrar.addEventListener("click", () => {
                if (!confirm(`¿Borrar la seña «${sena.nombre}» del guante?`)) return;
                enviarComando("DEL|" + sena.nombre).catch(() => mostrarAvisoBiblioteca(textoErrorGuante("envio")));
            });
            li.appendChild(borrar);
        }

        listaBiblioteca.appendChild(li);
    });
}

/* ---------- Ventana "Agregar seña" ---------- */
function mostrarPasoCal(paso) {
    cal.paso = paso;
    Object.entries(calPasos).forEach(([nombre, el]) => { el.hidden = nombre !== paso; });
}

function abrirModalCalibracion() {
    calNombre.value = "";
    document.querySelector('input[name="calTipo"][value="0"]').checked = true;
    calErrorForm.hidden = true;
    mostrarPasoCal("form");
    modalCal.classList.remove("oculto");
    document.body.classList.add("modal-abierto");
    calNombre.focus();
}

function cerrarModalCalibracion() {
    if (cal.midiendo) return; // mientras el guante mide no se puede cerrar
    clearInterval(cal.temporizador);
    clearTimeout(cal.vigilante);
    cal.paso = "cerrado";
    modalCal.classList.add("oculto");
    document.body.classList.remove("modal-abierto");
    btnAgregarSena.focus();
}

function errorFormulario(texto) {
    calErrorForm.textContent = texto;
    calErrorForm.hidden = false;
}

function empezarCalibracion() {
    const nombre = calNombre.value.trim().toUpperCase();
    const movimiento = document.querySelector('input[name="calTipo"]:checked').value === "1";

    if (!nombre) return errorFormulario("Escribí el nombre de la seña o letra.");
    if ([...nombre].length > MAX_CARACTERES_NOMBRE) return errorFormulario(`El nombre puede tener hasta ${MAX_CARACTERES_NOMBRE} caracteres.`);
    if (/[|"\\]/.test(nombre)) return errorFormulario('El nombre no puede llevar los caracteres | " \\.');
    if (new TextEncoder().encode(nombre).length > MAX_BYTES_NOMBRE) return errorFormulario("El nombre es demasiado largo.");
    if (!guanteListoParaComandos()) return errorFormulario(textoErrorGuante("conexion"));

    const existente = estado.biblioteca.find(s => s.nombre === nombre);
    if (existente) {
        const mensaje = existente.defecto
            ? `Ya hay una seña de fábrica llamada «${nombre}». ¿Querés reemplazarla por la tuya?`
            : `Ya existe una seña llamada «${nombre}». ¿Querés reemplazarla?`;
        if (!confirm(mensaje)) return;
    }

    cal.nombre = nombre;
    cal.movimiento = movimiento;
    cal.midiendo = false;
    calErrorForm.hidden = true;

    // Pantalla de espera: primero una cuenta atrás para que la persona se prepare
    mostrarPasoCal("espera");
    calProgresoCaja.hidden = true;
    calBotonesEspera.hidden = false;
    calCuentaAtras.hidden = false;
    calCuentaAtras.classList.remove("ahora");
    calBarraRelleno.style.width = "0%";
    calInstruccion.textContent = movimiento
        ? `Preparate para «${nombre}»: cuando termine la cuenta, hacé el movimiento completo una y otra vez.`
        : `Preparate para «${nombre}»: cuando termine la cuenta, hacé la seña y mantené la mano quieta.`;

    let restante = SEGUNDOS_PREPARACION;
    calCuentaAtras.textContent = restante;
    clearInterval(cal.temporizador);
    cal.temporizador = setInterval(() => {
        restante--;
        if (restante > 0) {
            calCuentaAtras.textContent = restante;
        } else {
            clearInterval(cal.temporizador);
            iniciarMedicion();
        }
    }, 1000);
}

function iniciarMedicion() {
    cal.midiendo = true;
    calCuentaAtras.textContent = "¡Ahora!";
    calCuentaAtras.classList.add("ahora");
    calBotonesEspera.hidden = true;
    calProgresoCaja.hidden = false;
    calibracionProgreso(0, MUESTRAS_CALIBRACION);

    enviarComando(`CAL|${cal.nombre}|${cal.movimiento ? 1 : 0}`)
        .catch(() => calibracionError("envio"));

    reiniciarVigilante();
}

// Si el guante deja de dar señales (se apagó, se alejó), no se queda esperando para siempre
function reiniciarVigilante() {
    clearTimeout(cal.vigilante);
    cal.vigilante = setTimeout(() => {
        if (cal.paso === "espera") calibracionError("timeout");
    }, MS_ESPERA_RESPUESTA);
}

function calibracionProgreso(actual, total) {
    if (cal.paso !== "espera") return;
    const porcentaje = Math.min(100, Math.round((actual / total) * 100));
    calBarraRelleno.style.width = porcentaje + "%";
    calBarra.setAttribute("aria-valuemax", total);
    calBarra.setAttribute("aria-valuenow", actual);
    calContador.textContent = `Midiendo… ${actual} de ${total}`;
    if (actual > 0) reiniciarVigilante();
}

function mostrarResultado(ok, texto) {
    clearInterval(cal.temporizador);
    clearTimeout(cal.vigilante);
    cal.midiendo = false;
    mostrarPasoCal("resultado");
    calResultadoIcono.textContent = ok ? "✓" : "✕";
    calResultadoIcono.className = "cal-resultado-icono " + (ok ? "ok" : "error");
    calResultadoTexto.textContent = texto;
    calReintentar.hidden = ok;
}

function calibracionTerminada(d) {
    if (cal.paso !== "espera") return;
    let texto = `La seña «${d.n}» quedó guardada en tu guante.`;
    if (d.s) {
        texto += ` Ojo: se parece mucho a «${d.s}» y el guante podría confundirlas. Si pasa, volvé a calibrarla marcando más la seña.`;
    }
    mostrarResultado(true, texto);
}

function calibracionError(codigo) {
    if (cal.paso !== "espera") return;
    mostrarResultado(false, textoErrorGuante(codigo));
}

// Se llama desde alDesconectar()
function calibracionPerdioConexion() {
    if (cal.paso === "espera") calibracionError("conexion");
}

/* ---------- Eventos de la ventana ---------- */
btnAgregarSena.addEventListener("click", abrirModalCalibracion);
document.getElementById("calEmpezar").addEventListener("click", empezarCalibracion);
document.getElementById("calCancelarForm").addEventListener("click", cerrarModalCalibracion);
document.getElementById("calCancelarEspera").addEventListener("click", cerrarModalCalibracion);
document.getElementById("calX").addEventListener("click", cerrarModalCalibracion);
document.getElementById("calListo").addEventListener("click", cerrarModalCalibracion);
calReintentar.addEventListener("click", () => mostrarPasoCal("form"));

calNombre.addEventListener("keydown", (evento) => {
    if (evento.key === "Enter") empezarCalibracion();
});

modalCal.addEventListener("click", (evento) => {
    if (evento.target === modalCal) cerrarModalCalibracion();
});

document.addEventListener("keydown", (evento) => {
    if (evento.key === "Escape" && !modalCal.classList.contains("oculto")) cerrarModalCalibracion();
});

actualizarUICalibracion();

/* --------------------------------------------------------
   9) MANUALES DESCARGABLES (usuario y mantenimiento)
   Los PDF van en la carpeta "manuales/", al lado de index.html.
   Si cambiás el nombre de un archivo, cambialo también acá.
-------------------------------------------------------- */
const MANUALES = {
    usuario: {
        titulo: "Manual de usuario",
        texto: "Descargá el manual de usuario de KantoTech para aprender a conectar y usar tu guante.",
        archivo: "manuales/manual-de-usuario.pdf",
        nombreDescarga: "KantoTech-Manual-de-usuario.pdf"
    },
    mantenimiento: {
        titulo: "Manual de mantenimiento",
        texto: "Descargá el manual de mantenimiento de KantoTech para saber cómo cuidar tu guante.",
        archivo: "manuales/manual-de-mantenimiento.pdf",
        nombreDescarga: "KantoTech-Manual-de-mantenimiento.pdf"
    }
};

const modalManual = document.getElementById("modalManual");
const modalTitulo = document.getElementById("modalManualTitulo");
const modalPortada = document.getElementById("modalManualPortada");
const modalTexto = document.getElementById("modalManualTexto");
const modalDescarga = document.getElementById("modalManualDescarga");
const modalAviso = document.getElementById("modalManualAviso");
const modalCerrarX = document.getElementById("modalManualX");

let tokenVerificacion = 0;   // evita que una comprobación vieja pise a la actual
let botonQueAbrio = null;    // para devolverle el foco al cerrar

// Comprueba que el PDF exista, para no mandar a la persona a una página de error.
async function manualDisponible(ruta) {
    try {
        if (window.caches) {
            const guardado = await caches.match(ruta);   // sirve también sin internet
            if (guardado) return true;
        }
        const respuesta = await fetch(ruta, { method: "HEAD", cache: "no-store" });
        const tipo = respuesta.headers.get("content-type") || "";
        return respuesta.ok && !tipo.includes("text/html");
    } catch (_) {
        return false;
    }
}

function abrirManual(clave, origen) {
    const manual = MANUALES[clave];
    if (!manual) return;

    botonQueAbrio = origen || null;
    modalTitulo.textContent = manual.titulo;
    modalPortada.textContent = manual.titulo;
    modalTexto.textContent = manual.texto;
    modalDescarga.href = manual.archivo;
    modalDescarga.setAttribute("download", manual.nombreDescarga);
    modalDescarga.classList.remove("deshabilitado");
    modalDescarga.removeAttribute("aria-disabled");
    modalAviso.classList.add("oculto");

    modalManual.classList.remove("oculto");
    document.body.classList.add("modal-abierto");
    modalCerrarX.focus();

    const miToken = ++tokenVerificacion;
    manualDisponible(manual.archivo).then(existe => {
        if (miToken !== tokenVerificacion || modalManual.classList.contains("oculto")) return;
        if (!existe) {
            modalDescarga.classList.add("deshabilitado");
            modalDescarga.setAttribute("aria-disabled", "true");
            modalAviso.classList.remove("oculto");
        }
    });
}

function cerrarManual() {
    if (modalManual.classList.contains("oculto")) return;
    tokenVerificacion++;
    modalManual.classList.add("oculto");
    document.body.classList.remove("modal-abierto");
    if (botonQueAbrio) botonQueAbrio.focus();
}

document.querySelectorAll(".tarjeta-manual").forEach(tarjeta => {
    tarjeta.addEventListener("click", () => abrirManual(tarjeta.dataset.manual, tarjeta));
});

modalCerrarX.addEventListener("click", cerrarManual);
document.getElementById("modalManualCerrar").addEventListener("click", cerrarManual);

// clic en el fondo oscuro (fuera de la ventana) también cierra
modalManual.addEventListener("click", (evento) => {
    if (evento.target === modalManual) cerrarManual();
});

modalDescarga.addEventListener("click", (evento) => {
    if (modalDescarga.classList.contains("deshabilitado")) evento.preventDefault();
});

document.addEventListener("keydown", (evento) => {
    if (modalManual.classList.contains("oculto")) return;

    if (evento.key === "Escape") {
        cerrarManual();
        return;
    }

    // Tab dentro de la ventana: el foco no se escapa hacia el resto de la página
    if (evento.key === "Tab") {
        const enfocables = modalManual.querySelectorAll("button, a[href]:not(.deshabilitado)");
        if (enfocables.length === 0) return;
        const primero = enfocables[0];
        const ultimo = enfocables[enfocables.length - 1];

        if (evento.shiftKey && document.activeElement === primero) {
            evento.preventDefault();
            ultimo.focus();
        } else if (!evento.shiftKey && document.activeElement === ultimo) {
            evento.preventDefault();
            primero.focus();
        }
    }
});

/* --------------------------------------------------------
   10) FOOTER: año actual
-------------------------------------------------------- */
document.getElementById("anioPie").textContent = new Date().getFullYear();
