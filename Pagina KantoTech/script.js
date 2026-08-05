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
    oracion: [] // array de { tipo: 'letra' | 'espacio', valor }
};

const NOMBRES_DEDOS = ["Pulgar", "Índice", "Medio", "Anular", "Meñique"];
const MS_ESTABILIDAD = 550; // tiempo que una letra debe mantenerse para confirmarse en la cinta

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
    tarjetas.forEach((tarjeta, i) => {
        const crudo = Number(valores[i]) || 0;
        // normaliza: si viene en escala ADC (0-4095), lo pasamos a %; si ya es 0-100, lo dejamos
        const porcentaje = crudo > 100 ? Math.round((crudo / 4095) * 100) : Math.round(crudo);
        const acotado = Math.max(0, Math.min(100, porcentaje));

        tarjeta.querySelector(".sensor-barra-relleno").style.width = `${acotado}%`;
        tarjeta.querySelector(".sensor-valor").textContent = acotado;
    });
}

/* --------------------------------------------------------
   6) LÓGICA DE LETRA -> ORACIÓN
   Para que el guante no repita la misma letra en cada
   paquete BLE, sólo se confirma una letra en el renglón
   cuando se mantiene estable un ratito (MS_ESTABILIDAD).
-------------------------------------------------------- */
function procesarLetraDetectada(letra) {
    letraActualEl.textContent = letra || "–";

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

/* --------------------------------------------------------
   8) MENÚ HAMBURGUESA (placeholder simple)
-------------------------------------------------------- */
document.getElementById("btn").addEventListener("click", () => {
    document.querySelector(".menu").classList.toggle("menu-abierto");
});
