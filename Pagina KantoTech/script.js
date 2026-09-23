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
    ultimaLecturaSensor: [null, null, null, null, null] // timestamp del último dato de cada dedo
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
const pantallaPrincipal = document.getElementById("pantallaPrincipal");
const pantallaCalibracion = document.getElementById("pantallaCalibracion");

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
}

// Verificación y calibración de sensores: ahora es una pantalla aparte
document.getElementById("btnAbrirCalibracion").addEventListener("click", () => {
    pantallaPrincipal.classList.add("oculto");
    pantallaCalibracion.classList.remove("oculto");
    panelConfig.classList.add("oculto");
    btnConfig.classList.remove("activo");
});

document.getElementById("btnVolver").addEventListener("click", () => {
    pantallaCalibracion.classList.add("oculto");
    pantallaPrincipal.classList.remove("oculto");
    salirModoAislado();
});

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

    } catch (error) {
        console.error("No se pudo conectar:", error);
        actualizarEstadoConexion("desconectado");
        if (error.name !== "NotFoundError") {
            alert("No se pudo conectar con el guante. Revisá que esté encendido y en modo de emparejamiento.");
        }
    }
}

function alDesconectar() {
    actualizarEstadoConexion("desconectado");
    estado.ultimaLecturaSensor = [null, null, null, null, null];
    document.querySelectorAll(".sensor-tarjeta").forEach(marcarSensorError);
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
        letra = (datos.letra ?? datos.letter ?? datos.l ?? "").toString().toUpperCase();
        sensores = datos.flex ?? datos.sensores ?? datos.dedos ?? null;
    } catch (_) {
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
// Qué mostrar como imagen/ícono para cada seña reconocida. Por ahora
// usa emojis (funcionan ya, sin subir nada). Para usar fotos reales:
// poné los archivos en imagenes/ (ej. imagenes/piedra.png) y cambiá
// cada línea de acá por la ruta del archivo — más abajo en
// actualizarImagenSeña() ya está el código que decide si mostrar
// emoji o <img>, dependiendo de qué le pongas en este objeto.
const IMAGENES_SEÑA = {
    "PIEDRA":  "✊",
    "PAPEL":   "✋",
    "TIJERAS": "✌️"
};

function actualizarImagenSeña(letra) {
    const contenido = IMAGENES_SEÑA[letra];
    const imagenEl = document.getElementById("imagenSeña");

    if (!contenido) {
        imagenEl.innerHTML = "";
        return;
    }

    // Si lo que pusiste en IMAGENES_SEÑA termina en una extensión de
    // imagen, se muestra como <img>; si no, se asume que es un emoji
    // o texto y se muestra directo.
    const esArchivoDeImagen = /\.(png|jpg|jpeg|svg|webp|gif)$/i.test(contenido);

    if (esArchivoDeImagen) {
        imagenEl.innerHTML = `<img src="${contenido}" alt="${letra}">`;
    } else {
        imagenEl.textContent = contenido;
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
        span.textContent = item.tipo === "espacio" ? "" : item.valor;
        cinta.appendChild(span);
    });
    cinta.appendChild(cintaCursor);
    cinta.parentElement.scrollLeft = cinta.parentElement.scrollWidth;
}

