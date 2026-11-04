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
