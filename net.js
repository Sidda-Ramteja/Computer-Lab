"use strict";


/* =========================================================
   DATABASE
========================================================= */

const DB_KEY =
    "slotsync_db_v4";

const SESSION_KEY =
    "slotsync_session_v4";


let db = loadDB();

let currentUser = null;

let selectedRole = "";

let selectedUserCenterId = "";

let selectedAdminCenterId = "";

let userLocation = null;

let toastTimer = null;

let activeSessionId = null;

const prompted = new Set();



/* =========================================================
   BASIC FUNCTIONS
========================================================= */

function id(prefix){

    return (
        prefix +
        "_" +
        Date.now() +
        "_" +
        Math.random()
            .toString(36)
            .slice(2,8)
    );

}


function money(value){

    return new Intl.NumberFormat(
        "en-IN",
        {
            style:"currency",
            currency:"INR",
            minimumFractionDigits:2
        }
    ).format(
        Number(value) || 0
    );

}


function dt(value){

    return value

        ? new Date(value)
            .toLocaleString(
                "en-IN",
                {
                    dateStyle:"medium",
                    timeStyle:"short"
                }
            )

        : "—";

}


function esc(value){

    return String(value ?? "")

        .replaceAll("&","&amp;")
        .replaceAll("<","&lt;")
        .replaceAll(">","&gt;")
        .replaceAll('"',"&quot;")
        .replaceAll("'","&#039;");

}


function dur(minutes){

    let hours =
        Math.floor(
            (Number(minutes)||0) / 60
        );

    let remaining =
        (Number(minutes)||0) % 60;


    if(hours && remaining){

        return (
            hours +
            "h " +
            remaining +
            "m"
        );

    }


    if(hours){

        return hours + "h";

    }


    return remaining + "m";

}


function charge(
    minutes,
    rate
){

    return (
        Number(minutes) /
        60
    ) *
    Number(rate);

}



/* =========================================================
   DATA HELPERS
========================================================= */

function getCenter(centerId){

    return db.centers.find(
        center =>
            center.id === centerId
    ) || null;

}


function getUser(userId){

    return db.users.find(
        user =>
            user.id === userId
    ) || null;

}


function adminCenters(){

    return (

        currentUser?.role === "admin"

            ? db.centers.filter(
                center =>
                    center.ownerId ===
                    currentUser.id
              )

            : []

    );

}


function centerQueue(centerId){

    return db.queue

        .filter(
            item =>
                item.centerId ===
                centerId
        )

        .sort(
            (a,b) =>
                a.createdAt -
                b.createdAt
        );

}


function activeBookings(){

    return db.bookings.filter(
        booking =>

            booking.status === "scheduled" ||

            booking.status === "active"
    );

}


function save(){

    localStorage.setItem(
        DB_KEY,
        JSON.stringify(db)
    );

}



/* =========================================================
   SYSTEM CREATION
========================================================= */

function systems(count){

    return Array.from(
        {length:count},
        (_,index) => ({

            id:
                `sys_${Date.now()}_${index}_${Math.random()
                    .toString(36)
                    .slice(2,5)}`,

            name:
                `System ${index + 1}`,

            notWorking:
                false,

            note:
                "",

            specs:
                "Standard workstation"

        })
    );

}



/* =========================================================
   DEMO DATABASE
========================================================= */

function seed(){
    return { users: [], centers: [], bookings: [], queue: [], bills: [] };
}

function loadDB(){
    try {
        const stored = localStorage.getItem(DB_KEY);
        if (stored) {
            const data = JSON.parse(stored);
            return {
                users: Array.isArray(data.users) ? data.users : [],
                centers: Array.isArray(data.centers) ? data.centers : [],
                bookings: Array.isArray(data.bookings) ? data.bookings : [],
                queue: Array.isArray(data.queue) ? data.queue : [],
                bills: Array.isArray(data.bills) ? data.bills : []
            };
        }
    } catch (error) {
        console.error("Database loading error:", error);
    }
    const data = seed();
    localStorage.setItem(DB_KEY, JSON.stringify(data));
    return data;
}


/* =========================================================
   AVAILABILITY
========================================================= */

function availableSystems(
    center,
    start,
    end
){

    if(!center){

        return [];

    }


    return center.systems.filter(
        system =>

            !system.notWorking &&

            !activeBookings().some(
                booking =>

                    booking.centerId ===
                        center.id &&

                    booking.systemId ===
                        system.id &&

                    booking.startAt <
                        end &&

                    booking.endAt >
                        start
            )
    );

}


function availability(center){

    const now =
        Date.now();


    const available =
        availableSystems(
            center,
            now,
            now + 60000
        ).length;


    return {

        available,

        occupied:
            center.systems.filter(
                system =>
                    !system.notWorking
            ).length -
            available,

        offline:
            center.systems.filter(
                system =>
                    system.notWorking
            ).length

    };

}



/* =========================================================
   FIND NEXT SLOT
========================================================= */

function slotForSystem(
    center,
    system,
    start,
    duration
){

    let cursor =
        Math.max(
            Date.now(),
            start
        );


    const required =
        duration * 60000;


    const bookings =
        activeBookings()

            .filter(
                booking =>

                    booking.centerId ===
                        center.id &&

                    booking.systemId ===
                        system.id
            )

            .sort(
                (a,b) =>
                    a.startAt -
                    b.startAt
            );


    for(
        const booking of bookings
    ){

        if(
            booking.endAt <=
            cursor
        ){

            continue;

        }


        if(
            booking.startAt -
            cursor >=
            required
        ){

            break;

        }


        cursor =
            Math.max(
                cursor,
                booking.endAt
            );

    }


    return {

        systemId:
            system.id,

        startAt:
            cursor

    };

}



function findSlot(
    center,
    start,
    duration,
    preferred = "auto"
){

    let systemList =
        center.systems.filter(
            system =>
                !system.notWorking
        );


    if(
        preferred !==
        "auto"
    ){

        systemList =
            systemList.filter(
                system =>
                    system.id ===
                    preferred
            );

    }


    let best =
        null;


    systemList.forEach(
        system => {

            const result =
                slotForSystem(
                    center,
                    system,
                    start,
                    duration
                );


            if(
                !best ||
                result.startAt <
                best.startAt
            ){

                best =
                    result;

            }

        }
    );


    return best;

}



/* =========================================================
   STATE PROCESSING
========================================================= */

function updateState(){

    const now =
        Date.now();


    let changed =
        false;


    /* Bookings */

    for(
        const booking of db.bookings
    ){

        if(

            (
                booking.status ===
                    "scheduled" ||

                booking.status ===
                    "active"

            ) &&

            now >=
                booking.endAt

        ){

            booking.status =
                "expired";

            changed =
                true;

        }


        else if(

            booking.status ===
                "scheduled" &&

            now >=
                booking.startAt

        ){

            booking.status =
                "active";

            changed =
                true;

        }

    }


    /* Queue allocation */

    for(
        const queueEntry of
        [...db.queue].sort(
            (a,b) =>
                a.createdAt -
                b.createdAt
        )
    ){

        const center =
            getCenter(
                queueEntry.centerId
            );


        if(
            !center ||
            center.status !==
                "open" ||
            queueEntry.requestedStart >
                now
        ){

            continue;

        }


        const slot =
            findSlot(
                center,
                now,
                queueEntry.duration,
                queueEntry.preferredSystem
            );


        if(
            slot &&
            slot.startAt <=
                now &&
            availableSystems(
                center,
                now,
                now +
                queueEntry.duration *
                60000
            ).some(
                system =>
                    system.id ===
                    slot.systemId
            )
        ){

            db.bookings.push({

                id:
                    id("b"),

                userId:
                    queueEntry.userId,

                centerId:
                    center.id,

                systemId:
                    slot.systemId,

                startAt:
                    now,

                endAt:
                    now +
                    queueEntry.duration *
                    60000,

                duration:
                    queueEntry.duration,

                rate:
                    queueEntry.rate,

                total:
                    queueEntry.total,

                status:
                    "active",

                createdAt:
                    now,

                fromQueue:
                    true

            });


            db.queue =
                db.queue.filter(
                    item =>
                        item.id !==
                        queueEntry.id
                );


            changed =
                true;

        }

    }


    if(changed){

        save();

    }


    /* Session reminder */

    if(
        currentUser?.role ===
        "user"
    ){

        for(
            const booking of
            db.bookings.filter(
                item =>

                    item.userId ===
                        currentUser.id &&

                    item.status ===
                        "expired"
            )
        ){

            if(
                !prompted.has(
                    booking.id
                )
            ){

                prompted.add(
                    booking.id
                );


                setTimeout(
                    () =>
                        openSessionModal(
                            booking.id
                        ),
                    150
                );

            }

        }

    }

}



/* =========================================================
   NAVIGATION
========================================================= */

function pageTitle(
    kicker,
    title,
    chip=""
){

    document.getElementById(
        "pageKicker"
    ).textContent =
        kicker;


    document.getElementById(
        "pageTitle"
    ).textContent =
        title;


    const chipElement =
        document.getElementById(
            "selectedCenterChip"
        );


    if(chip){

        chipElement.textContent =
            chip;

        chipElement.classList.remove(
            "hidden"
        );

    }

    else{

        chipElement.classList.add(
            "hidden"
        );

    }

}



function showPage(page){

    document
        .querySelectorAll(
            ".page"
        )
        .forEach(
            item =>
                item.classList.add(
                    "hidden"
                )
        );


    const selected =
        document.getElementById(
            page
        );


    if(selected){

        selected.classList.remove(
            "hidden"
        );

    }


    document
        .querySelectorAll(
            ".nav-item"
        )
        .forEach(
            item =>
                item.classList.toggle(
                    "active",
                    item.dataset.page ===
                    page
                )
        );

}



function renderNavigation(){

    const navElement =
        document.getElementById(
            "mainNav"
        );


    if(
        currentUser.role ===
        "user"
    ){

        navElement.innerHTML = `

            <button
                class="nav-item"
                data-page="user-overview">

                <span>⌂</span>
                <span>Overview</span>

            </button>


            <button
                class="nav-item"
                data-page="user-centers">

                <span>⌕</span>
                <span>Find Centers</span>

            </button>


            <button
                class="nav-item"
                data-page="user-bookings">

                <span>▣</span>
                <span>My Bookings</span>

            </button>


            <button
                class="nav-item"
                data-page="user-queue">

                <span>◷</span>
                <span>My Queue</span>

            </button>


            <button
                class="nav-item"
                data-page="user-activity">

                <span>▤</span>
                <span>Activity & Bills</span>

            </button>

        `;

    }

    else{

        navElement.innerHTML = `

            <button
                class="nav-item"
                data-page="admin-overview">

                <span>⌂</span>
                <span>Overview</span>

            </button>


            <button
                class="nav-item"
                data-page="admin-centers">

                <span>▦</span>
                <span>My Centers</span>

            </button>


            <button
                class="nav-item"
                data-page="admin-workspace">

                <span>⚙</span>
                <span>Center Workspace</span>

            </button>


            <button
                class="nav-item"
                data-page="admin-systems">

                <span>▣</span>
                <span>Systems</span>

            </button>


            <button
                class="nav-item"
                data-page="admin-operations">

                <span>≡</span>
                <span>Operations</span>

            </button>

        `;

    }

}



function go(page){

    updateState();

    showPage(page);


    if(
        page ===
        "user-overview"
    ){

        renderUserOverview();

    }


    if(
        page ===
        "user-centers"
    ){

        renderUserCenters();

    }


    if(
        page ===
        "user-center-detail"
    ){

        renderUserCenterDetail();

    }


    if(
        page ===
        "user-bookings"
    ){

        renderUserBookings();

    }


    if(
        page ===
        "user-queue"
    ){

        renderUserQueue();

    }


    if(
        page ===
        "user-activity"
    ){

        renderUserActivity();

    }


    if(
        page ===
        "admin-overview"
    ){

        renderAdminOverview();

    }


    if(
        page ===
        "admin-centers"
    ){

        renderAdminCenters();

    }


    if(
        page ===
        "admin-workspace"
    ){

        renderAdminWorkspace();

    }


    if(
        page ===
        "admin-systems"
    ){

        renderAdminSystems();

    }


    if(
        page ===
        "admin-operations"
    ){

        renderAdminOperations();

    }

}



/* =========================================================
   AUTH
========================================================= */

function authMessage(
    text,
    type
){

    const box =
        document.getElementById(
            "authMessage"
        );


    box.textContent =
        text;


    box.className =
        `notice ${type}`;

}



function selectRole(role){

    selectedRole =
        role;


    document
        .getElementById(
            "roleChooser"
        )
        .classList.add(
            "hidden"
        );


    document
        .getElementById(
            "authFormArea"
        )
        .classList.remove(
            "hidden"
        );


    document
        .getElementById(
            "selectedRoleIcon"
        )
        .textContent =
        role === "admin"
            ? "🏪"
            : "👤";


    document
        .getElementById(
            "selectedRoleLabel"
        )
        .textContent =
        role === "admin"
            ? "ADMIN / OWNER"
            : "CUSTOMER";


    document
        .getElementById(
            "selectedRoleTitle"
        )
        .textContent =
        role === "admin"
            ? "Admin Login"
            : "Customer Login";
document
        .getElementById(
            "authMessage"
        )
        .classList.add(
            "hidden"
        );



    const hasAccounts = db.users.length > 0;
    document.getElementById("showLogin").classList.toggle("hidden", !hasAccounts);
    document.getElementById("showRegister").classList.toggle("hidden", false);
    if (!hasAccounts) {
        document.getElementById("showRegister").classList.add("active");
        document.getElementById("showLogin").classList.remove("active");
        document.getElementById("registerForm").classList.remove("hidden");
        document.getElementById("loginForm").classList.add("hidden");
        document.getElementById("selectedRoleTitle").textContent =
            role === "admin" ? "Create Admin Account" : "Create Customer Account";
    } else {
        document.getElementById("showLogin").classList.remove("hidden");
        document.getElementById("showLogin").classList.add("active");
        document.getElementById("showRegister").classList.remove("active");
        document.getElementById("loginForm").classList.remove("hidden");
        document.getElementById("registerForm").classList.add("hidden");
    }
}



function login(
    email,
    password
){
    if (!db.users.length) {
        authMessage("Create your first account before logging in.", "error");
        return;
    }

    const user =
        db.users.find(
            item =>

                item.email
                    .toLowerCase() ===
                email
                    .trim()
                    .toLowerCase() &&

                item.password ===
                    password &&

                item.role ===
                    selectedRole
        );


    if(!user){

        authMessage(
            "Invalid credentials for the selected account type.",
            "error"
        );

        return;

    }


    currentUser =
        user;


    localStorage.setItem(
        SESSION_KEY,
        user.id
    );


    openApplication();

}



function register(
    name,
    email,
    password
){

    if(
        db.users.some(
            user =>
                user.email
                    .toLowerCase() ===
                email
                    .trim()
                    .toLowerCase()
        )
    ){

        authMessage(
            "An account with this email already exists.",
            "error"
        );

        return;

    }


    if(
        password.length <
        6
    ){

        authMessage(
            "Password must contain at least 6 characters.",
            "error"
        );

        return;

    }


    const user = {

        id:
            id("u"),

        name:
            name.trim(),

        email:
            email
                .trim()
                .toLowerCase(),

        password,

        role:
            selectedRole

    };


    db.users.push(
        user
    );


    save();


    currentUser =
        user;


    localStorage.setItem(
        SESSION_KEY,
        user.id
    );


    openApplication();


    showToast(
        "Account created successfully.",
        "success"
    );

}



function setHeader(){

    document.getElementById(
        "sidebarRole"
    ).textContent =

        currentUser.role ===
        "admin"

            ? "Admin / Owner"

            : "Customer";


    document.getElementById(
        "sidebarName"
    ).textContent =
        currentUser.name;


    document.getElementById(
        "sidebarEmail"
    ).textContent =
        currentUser.email;


    document.getElementById(
        "sidebarAvatar"
    ).textContent =
        currentUser.name
            .charAt(0)
            .toUpperCase();

}



function openApplication(){

    document
        .getElementById(
            "authView"
        )
        .classList.add(
            "hidden"
        );


    document
        .getElementById(
            "appView"
        )
        .classList.remove(
            "hidden"
        );


    setHeader();

    renderNavigation();


    go(
        currentUser.role ===
            "user"
            ? "user-overview"
            : "admin-overview"
    );

}



function logout(){

    localStorage.removeItem(
        SESSION_KEY
    );

    location.reload();

}



/* =========================================================
   LOCATION
========================================================= */

function centerDistance(
    center
){

    if(
        !userLocation ||
        center.lat == null ||
        center.lng == null
    ){

        return null;

    }


    const R =
        6371;


    const toRad =
        value =>
            value *
            Math.PI /
            180;


    const dLat =
        toRad(
            center.lat -
            userLocation.lat
        );


    const dLng =
        toRad(
            center.lng -
            userLocation.lng
        );


    const a =

        Math.sin(
            dLat / 2
        ) ** 2 +

        Math.cos(
            toRad(
                userLocation.lat
            )
        ) *

        Math.cos(
            toRad(
                center.lat
            )
        ) *

        Math.sin(
            dLng / 2
        ) ** 2;


    return (

        2 *

        R *

        Math.asin(
            Math.sqrt(a)
        )

    );

}



/* =========================================================
   USER OVERVIEW
========================================================= */

function renderUserOverview(){

    pageTitle(
        "CUSTOMER",
        "Overview"
    );


    const centers =
        db.centers.filter(
            center =>
                center.status ===
                "open"
        );


    let available = 0;

    let occupied = 0;


    centers.forEach(
        center => {

            const info =
                availability(
                    center
                );


            available +=
                info.available;


            occupied +=
                info.occupied;

        }
    );


    document.getElementById(
        "uStatCenters"
    ).textContent =
        centers.length;


    document.getElementById(
        "uStatAvailable"
    ).textContent =
        available;


    document.getElementById(
        "uStatOccupied"
    ).textContent =
        occupied;


    document.getElementById(
        "uStatQueue"
    ).textContent =

        db.queue.filter(
            item =>
                item.userId ===
                currentUser.id
        ).length;


    document.getElementById(
        "userWelcome"
    ).textContent =

        `Good evening, ${
            currentUser.name
                .split(" ")[0]
        } 👋`;


    const next =
        db.bookings

            .filter(
                booking =>

                    booking.userId ===
                        currentUser.id &&

                    (
                        booking.status ===
                            "scheduled" ||

                        booking.status ===
                            "active"
                    )
            )

            .sort(
                (a,b) =>
                    a.startAt -
                    b.startAt
            )[0];


    const box =
        document.getElementById(
            "uNextBooking"
        );


    if(!next){

        box.innerHTML = `

            <div class="empty-state">

                <span>
                    📅
                </span>

                <h3>
                    No upcoming booking
                </h3>

                <p>
                    Pick a center to reserve a computer.
                </p>

            </div>

        `;

        return;

    }


    const center =
        getCenter(
            next.centerId
        );


    const system =
        center?.systems.find(
            item =>
                item.id ===
                next.systemId
        );


    box.innerHTML = `

        <div class="list-row">

            <div>

                <span class="status-badge ${next.status}">
                    ${next.status.toUpperCase()}
                </span>

                <h4>
                    ${esc(center?.name)}
                </h4>

                <p>
                    ${esc(system?.name)}
                </p>

            </div>


            <div>

                <strong>
                    ${dt(next.startAt)}
                </strong>

                <small>
                    ${dur(next.duration)}
                </small>

            </div>


            <div>

                <strong>
                    ${money(next.total)}
                </strong>

                <small>
                    ${money(next.rate)}/hour
                </small>

            </div>


            <div>

                <button
                    class="btn secondary"
                    data-go="user-bookings">

                    Open

                </button>

            </div>

        </div>

    `;

}



/* =========================================================
   USER CENTER SEARCH
========================================================= */

function renderUserCenters(){

    pageTitle(
        "DISCOVER",
        "Find a computer hub"
    );


    const search =
        document.getElementById(
            "centerSearch"
        )
        .value
        .trim()
        .toLowerCase();


    const sort =
        document.getElementById(
            "centerSort"
        )
        .value;


    let centers =
        db.centers.filter(
            center =>

                center.status ===
                    "open" &&

                (
                    !search ||

                    `${center.name}
                     ${center.city}
                     ${center.address}`
                        .toLowerCase()
                        .includes(
                            search
                        )
                )
        );


    centers.sort(
        (a,b) => {

            if(
                sort ===
                "name"
            ){

                return a.name
                    .localeCompare(
                        b.name
                    );

            }


            if(
                sort ===
                "rate"
            ){

                return a.rate -
                    b.rate;

            }


            if(
                sort ===
                "availability"
            ){

                return (
                    availability(b)
                        .available -

                    availability(a)
                        .available
                );

            }


            const da =
                centerDistance(a);


            const dbDistance =
                centerDistance(b);


            if(
                da != null &&
                dbDistance != null
            ){

                return da -
                    dbDistance;

            }


            return (
                availability(b)
                    .available -

                availability(a)
                    .available
            );

        }
    );


    const wrapper =
        document.getElementById(
            "centerResults"
        );


    wrapper.innerHTML =
        "";


    document
        .getElementById(
            "centerEmpty"
        )
        .classList.toggle(
            "hidden",
            centers.length !== 0
        );


    centers.forEach(
        center => {

            const av =
                availability(
                    center
                );


            const distance =
                centerDistance(
                    center
                );


            const selected =
                center.id ===
                selectedUserCenterId;


            const card =
                document.createElement(
                    "article"
                );


            card.className =
                `center-card ${
                    selected
                        ? "selected"
                        : ""
                }`;


            card.innerHTML = `

                <div
                    class="center-card-top">

                    <div>

                        <h3>
                            ${esc(center.name)}
                        </h3>

                        <div class="muted">
                            📍
                            ${esc(center.city)}
                            ·
                            ${esc(center.address)}
                        </div>
                        <a class="map-link" target="_blank" rel="noopener noreferrer"
                           href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(center.lat + "," + center.lng)}">
                           📍 Navigate to this hub
                        </a>

                    </div>


                    <span class="pill open">
                        OPEN
                    </span>

                </div>


                <div
                    class="center-card-grid">

                    <div class="mini-stat">

                        <span>
                            Systems
                        </span>

                        <b>
                            ${center.systems.length}
                        </b>

                    </div>


                    <div class="mini-stat">

                        <span>
                            Available
                        </span>

                        <b>
                            ${av.available}
                        </b>

                    </div>


                    <div class="mini-stat">

                        <span>
                            Rate
                        </span>

                        <b>
                            ${money(center.rate)}/h
                        </b>

                    </div>

                </div>


                <div
                    class="center-card-actions">

                    <span class="distance">

                        ${
                            distance == null

                                ? "Use location to calculate"

                                : distance < 1

                                    ? Math.round(
                                        distance * 1000
                                      ) +
                                      " m away"

                                    : distance.toFixed(1) +
                                      " km away"
                        }

                    </span>


                    <button
                        class="btn secondary select-center"
                        data-id="${center.id}">

                        ${
                            selected
                                ? "Selected · View"
                                : "View Center"
                        }

                        →

                    </button>

                </div>

            `;


            wrapper.appendChild(
                card
            );

        }
    );

}



/* =========================================================
   USER CENTER DETAIL
========================================================= */

function renderUserCenterDetail(){

    const center =
        getCenter(
            selectedUserCenterId
        );


    pageTitle(
        "CENTER DETAILS",
        center
            ? center.name
            : "Center",
        center
            ? center.city
            : ""
    );


    const wrapper =
        document.getElementById(
            "selectedCenterDetail"
        );


    if(!center){

        wrapper.innerHTML = `

            <div class="empty-state">

                <span>
                    🏢
                </span>

                <h3>
                    Select a center first
                </h3>

                <button
                    class="btn primary"
                    data-go="user-centers">

                    Browse Centers

                </button>

            </div>

        `;

        return;

    }


    const info =
        availability(
            center
        );


    wrapper.innerHTML = `

        <div
            class="selected-center-hero">

            <div class="top">

                <div>

                    <span class="eyebrow">
                        SELECTED CENTER
                    </span>

                    <h1>
                        ${esc(center.name)}
                    </h1>

                    <p>
                        ${esc(center.address)},
                        ${esc(center.city)}
                        ·
                        ${esc(center.pin || "")}
                    </p>


                    <div class="center-contact">

                        <span class="contact-chip">
                            ☎
                            ${esc(center.phone)}
                        </span>

                        <span class="contact-chip">
                            ✉
                            ${esc(
                                center.email ||
                                "Not provided"
                            )}
                        </span>

                        <span class="contact-chip">
                            🕒
                            ${esc(
                                center.hours ||
                                "Hours not set"
                            )}
                        </span>

                        <span class="contact-chip">
                            ₹${center.rate}/hour
                        </span>

                    </div>

                </div>


                <div>

                    <button
                        class="btn ghost"
                        data-go="user-centers">

                        ← Change Center

                    </button>


                    <button
                        class="btn primary"
                        id="openBookingBtn">

                        Book a Computer

                    </button>

                </div>

            </div>


            <div class="detail-stats">

                <div class="metric">

                    <span>
                        Available
                    </span>

                    <strong>
                        ${info.available}
                    </strong>

                    <small>
                        Bookable now
                    </small>

                </div>


                <div class="metric">

                    <span>
                        Occupied
                    </span>

                    <strong>
                        ${info.occupied}
                    </strong>

                    <small>
                        In use
                    </small>

                </div>


                <div class="metric">

                    <span>
                        Temporarily unavailable
                    </span>

                    <strong>
                        ${info.offline}
                    </strong>

                    <small>
                        Under repair
                    </small>

                </div>


                <div class="metric">

                    <span>
                        Hourly rate
                    </span>

                    <strong>
                        ${money(center.rate)}
                    </strong>

                    <small>
                        Set by admin
                    </small>

                </div>

            </div>

        </div>


        <div class="card">

            <div class="section-head">

                <div>

                    <h3>
                        Systems at this center
                    </h3>

                    <p>
                        Booking options appear only after
                        clicking "Book a Computer".
                    </p>

                </div>

            </div>


            <div
                class="computer-grid"
                id="userComputerGrid">
            </div>

        </div>


        <div
            id="userBookingDrawer"
            class="booking-drawer hidden">
        </div>

    `;


    const grid =
        document.getElementById(
            "userComputerGrid"
        );


    center.systems.forEach(
        system => {

            const live =
                activeBookings().find(
                    booking =>

                        booking.centerId ===
                            center.id &&

                        booking.systemId ===
                            system.id &&

                        booking.startAt <=
                            Date.now() &&

                        booking.endAt >
                            Date.now()
                );


            const state =
                system.notWorking

                    ? "disabled"

                    : live
                        ? "occupied"
                        : "available";


            const card =
                document.createElement(
                    "article"
                );


            card.className =
                `computer-card ${state}`;


            card.innerHTML = `

                <div
                    class="computer-top">

                    <span class="computer-icon">
                        🖥️
                    </span>


                    <span
                        class="status-dot ${state}">

                        ${
                            system.notWorking

                                ? "Temporarily unavailable"

                                : live

                                    ? "Occupied"

                                    : "Available"
                        }

                    </span>

                </div>


                <h4>
                    ${esc(system.name)}
                </h4>


                <p>
                    ${esc(
                        system.specs ||
                        "Standard workstation"
                    )}
                </p>


                ${
                    system.notWorking

                        ? `

                            <p>

                                <b>
                                    Repair note:
                                </b>

                                ${esc(
                                    system.note ||
                                    "Needs repair"
                                )}

                            </p>

                          `

                        : live

                            ? `

                                <p>
                                    Busy until
                                    ${dt(live.endAt)}
                                </p>

                              `

                            : `

                                <p>
                                    Ready for booking
                                </p>

                              `
                }


                <button
                    class="btn secondary book-system"
                    data-system="${system.id}"
                    ${
                        system.notWorking ||
                        live
                            ? "disabled"
                            : ""
                    }>

                    ${
                        system.notWorking

                            ? "Unavailable"

                            : live

                                ? "Occupied"

                                : "Book this computer"
                    }

                </button>

            `;


            grid.appendChild(
                card
            );

        }
    );

}



/* =========================================================
   BOOKING DRAWER
========================================================= */

function localInput(timestamp){

    const date =
        new Date(timestamp);


    const pad =
        value =>
            String(value)
                .padStart(2,"0");


    return (

        date.getFullYear() +

        "-" +

        pad(
            date.getMonth()+1
        ) +

        "-" +

        pad(
            date.getDate()
        ) +

        "T" +

        pad(
            date.getHours()
        ) +

        ":" +

        pad(
            date.getMinutes()
        )

    );

}



function openBookingDrawer(
    systemId = "auto"
){

    const center =
        getCenter(
            selectedUserCenterId
        );


    const drawer =
        document.getElementById(
            "userBookingDrawer"
        );


    drawer.classList.remove(
        "hidden"
    );


    const systemOptions =
        center.systems

            .filter(
                system =>
                    !system.notWorking
            )

            .map(
                system => `

                    <option
                        value="${system.id}"
                        ${
                            system.id ===
                            systemId
                                ? "selected"
                                : ""
                        }>

                        ${esc(
                            system.name
                        )}

                    </option>

                `
            )
            .join("");


    drawer.innerHTML = `

        <div class="section-head">

            <div>

                <h3>
                    Book a Computer
                </h3>

                <p>
                    Choose a system,
                    start time and duration.
                </p>

            </div>


            <button
                class="close"
                id="closeBooking">

                ×

            </button>

        </div>


        <div class="booking-grid">

            <div class="field">

                <label>
                    Computer
                </label>

                <select id="bookSystem">

                    <option value="auto">
                        Automatic —
                        first suitable system
                    </option>

                    ${systemOptions}

                </select>

            </div>


            <div class="field">

                <label>
                    Start time
                </label>

                <input
                    id="bookStart"
                    type="datetime-local">

            </div>


            <div class="field">

                <label>
                    Duration
                </label>

                <input
                    id="bookDuration"
                    type="number"
                    min="15"
                    step="15"
                    value="60">

            </div>


            <div class="rate-strip wide">

                <div>

                    <span>
                        Admin rate
                    </span>

                    <b>
                        ${money(center.rate)}/hour
                    </b>

                </div>


                <div>

                    <span>
                        Estimated charge
                    </span>

                    <b id="bookCharge">
                        ${money(center.rate)}
                    </b>

                </div>

            </div>


            <div
                class="selected-banner wide"
                id="bookCheck">

                Choose a time to check availability.

            </div>

        </div>


        <div class="inline-actions">

            <button
                class="btn ghost"
                id="closeBooking">

                Cancel

            </button>


            <button
                class="btn primary"
                id="confirmBook">

                Book / Join Queue

            </button>

        </div>

    `;


    document.getElementById(
        "bookStart"
    ).value =

        localInput(
            Math.ceil(
                Date.now() /
                900000
            ) *
            900000
        );


    document.getElementById(
        "bookSystem"
    ).addEventListener(
        "change",
        checkBook
    );


    document.getElementById(
        "bookStart"
    ).addEventListener(
        "input",
        checkBook
    );


    document.getElementById(
        "bookDuration"
    ).addEventListener(
        "input",
        checkBook
    );


    document.getElementById(
        "confirmBook"
    ).addEventListener(
        "click",
        submitBooking
    );


    document
        .querySelectorAll(
            "#closeBooking"
        )
        .forEach(
            button =>
                button.addEventListener(
                    "click",
                    () =>
                        drawer.classList.add(
                            "hidden"
                        )
                )
        );


    checkBook();

}



/* =========================================================
   CHECK BOOKING AVAILABILITY
========================================================= */

function checkBook(){

    const center =
        getCenter(
            selectedUserCenterId
        );


    const system =
        document.getElementById(
            "bookSystem"
        )?.value;


    const start =
        new Date(
            document.getElementById(
                "bookStart"
            )?.value
        ).getTime();


    const minutes =
        Number(
            document.getElementById(
                "bookDuration"
            )?.value
        );


    const message =
        document.getElementById(
            "bookCheck"
        );


    if(
        !center ||
        !Number.isFinite(start) ||
        !Number.isFinite(minutes)
    ){

        return;

    }


    document.getElementById(
        "bookCharge"
    ).textContent =

        money(
            charge(
                minutes,
                center.rate
            )
        );


    const end =
        start +
        minutes * 60000;


    if(
        start <
        Date.now() -
            120000
    ){

        message.textContent =
            "Start time cannot be in the past.";

        message.className =
            "selected-banner warn";

        return;

    }


    const suitable =
        availableSystems(
            center,
            start,
            end
        ).find(
            systemItem =>
                system === "auto" ||
                systemItem.id === system
        );


    if(suitable){

        message.textContent =

            `${suitable.name}
             is available from
             ${dt(start)}
             for ${dur(minutes)}.`;

        message.className =
            "selected-banner ok";

    }

    else{

        const next =
            findSlot(
                center,
                start,
                minutes,
                system
            );


        message.textContent =

            next

                ? `No system fits that exact period.
                   Next possible slot:
                   ${
                        center.systems.find(
                            s =>
                                s.id ===
                                next.systemId
                        )?.name ||
                        "System"
                   }
                   at ${dt(next.startAt)}.
                   Submit to join the queue.`

                : "No suitable slot found.";

        message.className =
            "selected-banner warn";

    }

}



/* =========================================================
   SUBMIT BOOKING
========================================================= */

function submitBooking(){

    const center =
        getCenter(
            selectedUserCenterId
        );


    const system =
        document.getElementById(
            "bookSystem"
        ).value;


    const start =
        new Date(
            document.getElementById(
                "bookStart"
            ).value
        ).getTime();


    const minutes =
        Number(
            document.getElementById(
                "bookDuration"
            ).value
        );


    const end =
        start +
        minutes * 60000;


    if(
        !center ||
        !Number.isFinite(start) ||
        !Number.isFinite(minutes) ||
        minutes < 15
    ){

        showToast(
            "Enter a valid time and duration.",
            "error"
        );

        return;

    }


    const suitable =
        availableSystems(
            center,
            start,
            end
        ).find(
            systemItem =>
                system === "auto" ||
                systemItem.id === system
        );


    if(suitable){

        db.bookings.push({

            id:
                id("b"),

            userId:
                currentUser.id,

            centerId:
                center.id,

            systemId:
                suitable.id,

            startAt:
                start,

            endAt:
                end,

            duration:
                minutes,

            rate:
                center.rate,

            total:
                charge(
                    minutes,
                    center.rate
                ),

            status:
                start <= Date.now()
                    ? "active"
                    : "scheduled",

            createdAt:
                Date.now()

        });


        save();


        showToast(
            `${suitable.name} booked successfully.`,
            "success"
        );

    }

    else{

        db.queue.push({

            id:
                id("q"),

            userId:
                currentUser.id,

            centerId:
                center.id,

            preferredSystem:
                system,

            requestedStart:
                start,

            duration:
                minutes,

            rate:
                center.rate,

            total:
                charge(
                    minutes,
                    center.rate
                ),

            createdAt:
                Date.now()

        });


        save();


        showToast(
            "No suitable system for that time. You are in the queue.",
            "warn"
        );

    }


    const queued = !suitable;
    const reference = queued ? db.queue[db.queue.length - 1].id : db.bookings[db.bookings.length - 1].id;
    document.getElementById("modalPanel").innerHTML = `
        <div class="booking-success-head">
            <div class="success-icon">${queued ? "⏳" : "✓"}</div>
            <span class="eyebrow">${queued ? "QUEUE CONFIRMED" : "BOOKING CONFIRMED"}</span>
            <h2>${queued ? "You have joined the queue!" : "Booking successful!"}</h2>
            <p>${queued ? "Your request has been saved. Check My Queue for updates." : "Your computer is reserved. Your booking details are below."}</p>
        </div>
        <div class="bill booking-receipt">
            <div class="bill-row"><span>Reference</span><b>${esc(reference)}</b></div>
            <div class="bill-row"><span>Computer Hub</span><b>${esc(center.name)}</b></div>
            <div class="bill-row"><span>System / Status</span><b>${esc(suitable ? suitable.name : "Queue request")}</b></div>
            <div class="bill-row"><span>Start time</span><b>${esc(dt(start))}</b></div>
            <div class="bill-row"><span>Duration</span><b>${esc(dur(minutes))}</b></div>
            <div class="bill-row"><span>Rate</span><b>${money(center.rate)}/hour</b></div>
            <div class="bill-total"><span>Estimated ${queued ? "charge if allocated" : "total"}</span><strong>${money(charge(minutes, center.rate))}</strong></div>
            <p class="muted receipt-note">This is a booking confirmation and estimate, not the final usage bill. The final bill is available after the session ends.</p>
        </div>
        <div class="modal-actions">
            <button class="btn ghost" id="printBookingReceipt">Print / Save Receipt</button>
            <button class="btn primary" id="bookingDone">View My ${queued ? "Queue" : "Bookings"}</button>
        </div>`;
    openModal();
    document.getElementById("printBookingReceipt").onclick = () => window.print();
    document.getElementById("bookingDone").onclick = () => {
        closeModal();
        go(queued ? "user-queue" : "user-bookings");
    };
}



/* =========================================================
   USER BOOKINGS PAGE
========================================================= */

function renderUserBookings(){

    pageTitle(
        "MY SCHEDULE",
        "My Bookings"
    );


    const wrapper =
        document.getElementById(
            "userBookingsList"
        );


    const list =
        db.bookings

            .filter(
                booking =>
                    booking.userId ===
                    currentUser.id
            )

            .sort(
                (a,b) =>
                    b.createdAt -
                    a.createdAt
            );


    wrapper.innerHTML = `

        <div class="table-list">
        </div>

    `;


    const table =
        wrapper.firstElementChild;


    if(!list.length){

        wrapper.innerHTML = `

            <div class="empty-state">

                <span>
                    📅
                </span>

                <h3>
                    No bookings
                </h3>

                <p>
                    Open Find Centers and
                    choose a computer.
                </p>

            </div>

        `;

        return;

    }


    list.forEach(
        booking => {

            const center =
                getCenter(
                    booking.centerId
                );


            const system =
                center?.systems.find(
                    s =>
                        s.id ===
                        booking.systemId
                );


            const bill =
                db.bills.find(
                    b =>
                        b.bookingId ===
                        booking.id
                );


            const row =
                document.createElement(
                    "div"
                );


            row.className =
                "list-row";


            row.innerHTML = `

                <div>

                    <span
                        class="status-badge ${booking.status}">

                        ${booking.status.toUpperCase()}

                    </span>

                    <h4>
                        ${esc(
                            center?.name ||
                            "Center"
                        )}
                    </h4>

                    <p>
                        ${esc(
                            system?.name ||
                            "System"
                        )}
                        ·
                        ${dt(
                            booking.startAt
                        )}
                    </p>

                </div>


                <div>

                    <strong>
                        ${dur(
                            booking.duration
                        )}
                    </strong>

                    <small>
                        Ends
                        ${dt(
                            booking.endAt
                        )}
                    </small>

                </div>


                <div>

                    <strong>
                        ${money(
                            booking.total
                        )}
                    </strong>

                    <small>

                        ${money(
                            booking.rate
                        )}
                        /hour

                        ${
                            bill
                                ? " · Bill ready"
                                : ""
                        }

                    </small>

                </div>


                <div class="list-actions">

                    ${
                        booking.status ===
                        "active"

                            ? `

                                <button
                                    class="btn secondary session-btn"
                                    data-id="${booking.id}">

                                    Session

                                </button>

                              `

                            : ""
                    }


                    ${
                        booking.status ===
                        "expired"

                            ? `

                                <button
                                    class="btn primary bill-btn"
                                    data-id="${booking.id}">

                                    Generate Bill

                                </button>

                              `

                            : ""
                    }


                    ${
                        booking.status ===
                            "scheduled" &&

                        booking.startAt >
                            Date.now()

                            ? `

                                <button
                                    class="btn danger cancel-btn"
                                    data-id="${booking.id}">

                                    Cancel

                                </button>

                              `

                            : ""
                    }

                </div>

            `;


            table.appendChild(
                row
            );

        }
    );

}



/* =========================================================
   USER QUEUE PAGE
========================================================= */

function renderUserQueue(){

    pageTitle(
        "WAITING LINE",
        "My Queue"
    );


    const wrapper =
        document.getElementById(
            "userQueueList"
        );


    const list =
        db.queue

            .filter(
                queue =>
                    queue.userId ===
                    currentUser.id
            )

            .sort(
                (a,b) =>
                    a.createdAt -
                    b.createdAt
            );


    wrapper.innerHTML =
        "";


    if(!list.length){

        wrapper.innerHTML = `

            <div class="empty-state">

                <span>
                    ✅
                </span>

                <h3>
                    Your queue is empty
                </h3>

                <p>
                    When a requested time is unavailable,
                    you can join the queue from a selected center.
                </p>

            </div>

        `;

        return;

    }


    list.forEach(
        queueItem => {

            const center =
                getCenter(
                    queueItem.centerId
                );


            const position =
                centerQueue(
                    center.id
                )
                .findIndex(
                    item =>
                        item.id ===
                        queueItem.id
                ) + 1;


            const slot =
                findSlot(
                    center,
                    Math.max(
                        queueItem.requestedStart,
                        Date.now()
                    ),
                    queueItem.duration,
                    queueItem.preferredSystem
                );


            const card =
                document.createElement(
                    "div"
                );


            card.className =
                "queue-card";


            card.innerHTML = `

                <div class="queue-head">

                    <div class="queue-position">

                        ${position}

                    </div>


                    <div>

                        <h3>
                            ${esc(
                                center.name
                            )}
                        </h3>

                        <p>

                            ${esc(
                                center.city
                            )}

                            ·

                            ${dur(
                                queueItem.duration
                            )}

                            · Requested

                            ${dt(
                                queueItem.requestedStart
                            )}

                        </p>

                    </div>

                </div>


                <div
                    class="selected-banner warn">

                    Expected next slot:

                    ${
                        slot

                            ? `

                                ${
                                    center.systems.find(
                                        system =>
                                            system.id ===
                                            slot.systemId
                                    )?.name ||
                                    "System"
                                }

                                at

                                ${dt(
                                    slot.startAt
                                )}

                              `

                            : "Waiting for availability"
                    }

                </div>


                <div class="inline-actions">

                    <button
                        class="btn danger leave-queue"
                        data-id="${queueItem.id}">

                        Leave Queue

                    </button>

                </div>

            `;


            wrapper.appendChild(
                card
            );

        }
    );

}



/* =========================================================
   USER ACTIVITY PAGE
========================================================= */

function renderUserActivity(){

    pageTitle(
        "HISTORY",
        "Activity & Bills"
    );


    const bookings =
        db.bookings.filter(
            booking =>
                booking.userId ===
                currentUser.id
        );


    const bills =
        db.bills.filter(
            bill =>
                bill.userId ===
                currentUser.id
        );


    document.getElementById(
        "uCompleted"
    ).textContent =

        bookings.filter(
            booking =>
                booking.status ===
                "completed"
        ).length;


    document.getElementById(
        "uBills"
    ).textContent =
        bills.length;


    document.getElementById(
        "uSpent"
    ).textContent =

        money(
            bills.reduce(
                (total,bill) =>
                    total +
                    bill.total,
                0
            )
        );


    const wrapper =
        document.getElementById(
            "userActivityList"
        );


    const completed =
        bookings

            .filter(
                booking =>
                    booking.status ===
                    "completed"
            )

            .sort(
                (a,b) =>
                    b.endAt -
                    a.endAt
            );


    wrapper.innerHTML = `

        <div class="table-list">
        </div>

    `;


    const table =
        wrapper.firstElementChild;


    if(!completed.length){

        wrapper.innerHTML = `

            <div class="empty-state">

                <span>
                    🧾
                </span>

                <h3>
                    No completed activity yet
                </h3>

                <p>
                    Completed sessions will appear here.
                </p>

            </div>

        `;

        return;

    }


    completed.forEach(
        booking => {

            const center =
                getCenter(
                    booking.centerId
                );


            const system =
                center?.systems.find(
                    item =>
                        item.id ===
                        booking.systemId
                );


            const bill =
                bills.find(
                    item =>
                        item.bookingId ===
                        booking.id
                );


            const row =
                document.createElement(
                    "div"
                );


            row.className =
                "list-row";


            row.innerHTML = `

                <div>

                    <h4>
                        ${esc(
                            center?.name ||
                            "Center"
                        )}
                    </h4>

                    <p>
                        ${esc(
                            system?.name ||
                            "System"
                        )}
                    </p>

                </div>


                <div>

                    <strong>
                        ${dur(
                            booking.duration
                        )}
                    </strong>

                    <small>
                        ${dt(
                            booking.endAt
                        )}
                    </small>

                </div>


                <div>

                    <strong>
                        ${money(
                            booking.total
                        )}
                    </strong>

                    <small>
                        ${
                            bill
                                ? "Bill generated"
                                : "Completed"
                        }
                    </small>

                </div>


                <div>

                    ${
                        bill

                            ? `

                                <button
                                    class="btn secondary bill-btn"
                                    data-id="${booking.id}">

                                    View Bill

                                </button>

                              `

                            : ""

                    }

                </div>

            `;


            table.appendChild(
                row
            );

        }
    );

}



/* =========================================================
   ADMIN STATS
========================================================= */

function adminStats(){

    const centers =
        adminCenters();


    let totalSystems =
        0;

    let available =
        0;

    let queue =
        0;


    centers.forEach(
        center => {

            const info =
                availability(
                    center
                );


            totalSystems +=
                center.systems.length;


            available +=
                info.available;


            queue +=
                centerQueue(
                    center.id
                ).length;

        }
    );


    return {

        centers:
            centers.length,

        total:
            totalSystems,

        available,

        queue

    };

}



/* =========================================================
   ADMIN OVERVIEW
========================================================= */

function renderAdminOverview(){

    pageTitle(
        "OWNER",
        "Overview"
    );


    document.getElementById(
        "adminWelcome"
    ).textContent =

        `Welcome back, ${
            currentUser.name
                .split(" ")[0]
        }`;


    const stats =
        adminStats();


    document.getElementById(
        "aStatCenters"
    ).textContent =
        stats.centers;


    document.getElementById(
        "aStatSystems"
    ).textContent =
        stats.total;


    document.getElementById(
        "aStatAvailable"
    ).textContent =
        stats.available;


    document.getElementById(
        "aStatQueue"
    ).textContent =
        stats.queue;


    const box =
        document.getElementById(
            "adminCenterSpotlight"
        );


    const centers =
        adminCenters();


    if(!centers.length){

        box.innerHTML = `

            <div class="empty-state">

                <span>
                    🏪
                </span>

                <h3>
                    No center yet
                </h3>

                <p>
                    Create a computer hub from My Centers.
                </p>

                <button
                    class="btn primary"
                    data-go="admin-centers">

                    Open My Centers

                </button>

            </div>

        `;

        return;

    }


    box.innerHTML = `

        <div class="content-grid two">

            ${

                centers
                    .slice(0,2)
                    .map(
                        center => {

                            const info =
                                availability(
                                    center
                                );


                            return `

                                <div class="card">

                                    <div class="section-head">

                                        <div>

                                            <span
                                                class="pill ${
                                                    center.status ===
                                                    "open"
                                                        ? "open"
                                                        : "closed"
                                                }">

                                                ${center.status.toUpperCase()}

                                            </span>

                                            <h3>
                                                ${esc(
                                                    center.name
                                                )}
                                            </h3>

                                            <p>

                                                ${esc(
                                                    center.city
                                                )}

                                                ·

                                                ${info.available}

                                                /

                                                ${center.systems.length}

                                                available

                                                ·

                                                ${money(
                                                    center.rate
                                                )}/hour

                                            </p>

                                        </div>


                                        <button
                                            class="btn secondary admin-select-center"
                                            data-id="${center.id}">

                                            Manage →

                                        </button>

                                    </div>

                                </div>

                            `;

                        }
                    )
                    .join("")

            }

        </div>

    `;

}



/* =========================================================
   ADMIN MY CENTERS
========================================================= */

function renderAdminCenters(){

    pageTitle(
        "OWNERSHIP",
        "My Centers"
    );


    const list =
        document.getElementById(
            "adminCenterList"
        );


    const centers =
        adminCenters();


    list.innerHTML =
        "";


    document
        .getElementById(
            "adminNoCenters"
        )
        .classList.toggle(
            "hidden",
            centers.length !== 0
        );


    centers.forEach(
        center => {

            const info =
                availability(
                    center
                );


            const selected =
                center.id ===
                selectedAdminCenterId;


            const card =
                document.createElement(
                    "article"
                );


            card.className =
                `admin-center-card ${
                    selected
                        ? "selected"
                        : ""
                }`;


            card.innerHTML = `

                <span
                    class="pill ${
                        center.status ===
                        "open"
                            ? "open"
                            : "closed"
                    }">

                    ${center.status.toUpperCase()}

                </span>


                <h3>
                    ${esc(
                        center.name
                    )}
                </h3>


                <p>
                    ${esc(
                        center.address
                    )},
                    ${esc(
                        center.city
                    )}
                </p>


                <div
                    class="center-card-grid">

                    <div class="mini-stat">

                        <span>
                            Systems
                        </span>

                        <b>
                            ${center.systems.length}
                        </b>

                    </div>


                    <div class="mini-stat">

                        <span>
                            Available
                        </span>

                        <b>
                            ${info.available}
                        </b>

                    </div>


                    <div class="mini-stat">

                        <span>
                            Rate
                        </span>

                        <b>
                            ${money(
                                center.rate
                            )}/h
                        </b>

                    </div>

                </div>


                <div
                    class="admin-center-actions">

                    <button
                        class="btn ${
                            selected
                                ? "primary"
                                : "secondary"
                        } select-admin-center"
                        data-id="${center.id}">

                        ${
                            selected
                                ? "Selected"
                                : "Select Center"
                        }

                    </button>


                    <button
                        class="btn ghost admin-manage"
                        data-id="${center.id}">

                        Open Workspace

                    </button>

                </div>

            `;


            list.appendChild(
                card
            );

        }
    );

}



/* =========================================================
   ADMIN CENTER WORKSPACE
========================================================= */

function renderAdminWorkspace(){

    const center =
        getCenter(
            selectedAdminCenterId
        );


    pageTitle(
        "CENTER WORKSPACE",
        center
            ? center.name
            : "Select Center",
        center
            ? center.city
            : ""
    );


    const header =
        document.getElementById(
            "adminSelectedCenterHeader"
        );


    if(!center){

        header.innerHTML = `

            <div class="empty-state">

                <span>
                    🏪
                </span>

                <h3>
                    Select one of your centers
                </h3>

                <button
                    class="btn primary"
                    data-go="admin-centers">

                    My Centers

                </button>

            </div>

        `;

        return;

    }


    const info =
        availability(
            center
        );


    header.innerHTML = `

        <div class="selected-center-hero">

            <div class="top">

                <div>

                    <span class="eyebrow">
                        SELECTED CENTER
                    </span>

                    <h1>
                        ${esc(center.name)}
                    </h1>

                    <p>
                        ${esc(center.address)},
                        ${esc(center.city)}
                        ·
                        ${esc(center.pin || "")}
                    </p>


                    <div class="center-contact">

                        <span class="contact-chip">
                            ☎
                            ${esc(center.phone)}
                        </span>

                        <span class="contact-chip">
                            🕒
                            ${esc(
                                center.hours ||
                                "Not set"
                            )}
                        </span>

                        <span class="contact-chip">
                            ₹${center.rate}/hour
                        </span>

                    </div>

                </div>


                <div>

                    <button
                        class="btn ghost"
                        data-go="admin-centers">

                        ← Change Center

                    </button>

                </div>

            </div>


            <div class="detail-stats">

                <div class="metric">

                    <span>
                        Systems
                    </span>

                    <strong>
                        ${center.systems.length}
                    </strong>

                </div>


                <div class="metric">

                    <span>
                        Available
                    </span>

                    <strong>
                        ${info.available}
                    </strong>

                </div>


                <div class="metric">

                    <span>
                        Occupied
                    </span>

                    <strong>
                        ${info.occupied}
                    </strong>

                </div>


                <div class="metric">

                    <span>
                        Not working
                    </span>

                    <strong>
                        ${info.offline}
                    </strong>

                </div>

            </div>

        </div>

    `;


    document
        .getElementById(
            "centerEditPanel"
        )
        .classList.add(
            "hidden"
        );

}



/* =========================================================
   EDIT CENTER PANEL
========================================================= */

function renderEditPanel(){

    const center =
        getCenter(
            selectedAdminCenterId
        );


    if(!center){

        return;

    }


    const panel =
        document.getElementById(
            "centerEditPanel"
        );


    panel.classList.remove(
        "hidden"
    );


    panel.innerHTML = `

        <div class="section-head">

            <div>

                <span class="eyebrow">
                    EDIT MODE
                </span>

                <h3>
                    Change Center Details
                </h3>

                <p>
                    These fields stay hidden
                    until you click Change Center Details.
                </p>

            </div>


            <button
                class="close"
                id="closeEdit">

                ×

            </button>

        </div>


        <div class="modal-grid">

            <div class="field">

                <label>
                    Name
                </label>

                <input
                    id="eName"
                    value="${esc(center.name)}"
                >

            </div>


            <div class="field">

                <label>
                    Phone
                </label>

                <input
                    id="ePhone"
                    value="${esc(center.phone)}"
                >

            </div>


            <div class="field">

                <label>
                    Email
                </label>

                <input
                    id="eEmail"
                    value="${esc(center.email || "")}"
                >

            </div>


            <div class="field">

                <label>
                    City
                </label>

                <input
                    id="eCity"
                    value="${esc(center.city)}"
                >

            </div>


            <div class="field wide">

                <label>
                    Address
                </label>

                <textarea
                    id="eAddress">${esc(center.address)}</textarea>

            </div>


            <div class="field">

                <label>
                    PIN
                </label>

                <input
                    id="ePin"
                    value="${esc(center.pin || "")}"
                >

            </div>


            <div class="field">

                <label>
                    Opening Hours
                </label>

                <input
                    id="eHours"
                    value="${esc(center.hours || "")}"
                >

            </div>


            <div class="field">

                <label>
                    Computer Rate / Hour
                </label>

                <input
                    id="eRate"
                    type="number"
                    min="1"
                    value="${center.rate}"
                >

            </div>


            <div class="field">

                <label>
                    Status
                </label>

                <select id="eStatus">

                    <option
                        value="open"
                        ${
                            center.status ===
                            "open"
                                ? "selected"
                                : ""
                        }>

                        Open

                    </option>


                    <option
                        value="closed"
                        ${
                            center.status ===
                            "closed"
                                ? "selected"
                                : ""
                        }>

                        Temporarily Closed

                    </option>

                </select>

            </div>

        </div>


        <div class="modal-actions">

            <button
                class="btn primary"
                id="saveEdit">

                Save Changes

            </button>

        </div>

    `;


    document
        .getElementById(
            "closeEdit"
        )
        .onclick = () => {

            panel.classList.add(
                "hidden"
            );

        };


    document
        .getElementById(
            "saveEdit"
        )
        .onclick = () => {

            center.name =
                document
                    .getElementById(
                        "eName"
                    )
                    .value
                    .trim();


            center.phone =
                document
                    .getElementById(
                        "ePhone"
                    )
                    .value
                    .trim();


            center.email =
                document
                    .getElementById(
                        "eEmail"
                    )
                    .value
                    .trim();


            center.city =
                document
                    .getElementById(
                        "eCity"
                    )
                    .value
                    .trim();


            center.address =
                document
                    .getElementById(
                        "eAddress"
                    )
                    .value
                    .trim();


            center.pin =
                document
                    .getElementById(
                        "ePin"
                    )
                    .value
                    .trim();


            center.hours =
                document
                    .getElementById(
                        "eHours"
                    )
                    .value
                    .trim();


            center.rate =
                Number(
                    document
                        .getElementById(
                            "eRate"
                        )
                        .value
                ) ||
                center.rate;


            center.status =
                document
                    .getElementById(
                        "eStatus"
                    )
                    .value;


            save();


            showToast(
                "Center details saved.",
                "success"
            );


            go(
                "admin-workspace"
            );

        };

}



/* =========================================================
   ADMIN SYSTEMS
========================================================= */

function renderAdminSystems(){

    const center =
        getCenter(
            selectedAdminCenterId
        );


    pageTitle(
        "SYSTEMS",
        center
            ? center.name
            : "Systems",
        center
            ? center.city
            : ""
    );


    document
        .getElementById(
            "adminSystemsHeader"
        )
        .innerHTML =

        center

            ? `

                <div
                    class="page-hero compact">

                    <div>

                        <span class="eyebrow">
                            SELECTED CENTER ONLY
                        </span>

                        <h1>
                            ${esc(center.name)}
                        </h1>

                        <p>
                            Only systems belonging
                            to this selected center are shown.
                        </p>

                    </div>


                    <button
                        class="btn ghost"
                        data-go="admin-centers">

                        ← Change Center

                    </button>

                </div>

              `

            : "";


    const grid =
        document.getElementById(
            "adminSystemsGrid"
        );


    grid.innerHTML =
        "";


    if(!center){

        return;

    }


    center.systems.forEach(
        system => {

            const live =
                activeBookings().find(
                    booking =>

                        booking.centerId ===
                            center.id &&

                        booking.systemId ===
                            system.id &&

                        booking.startAt <=
                            Date.now() &&

                        booking.endAt >
                            Date.now()
                );


            const card =
                document.createElement(
                    "article"
                );


            card.className =

                `admin-system-card ${
                    system.notWorking
                        ? "not-working"
                        : ""
                }`;


            card.innerHTML = `

                <button
                    class="system-gear system-details-btn"
                    data-id="${system.id}">

                    ⚙

                </button>


                <span
                    class="status-dot ${
                        system.notWorking
                            ? "disabled"
                            : live
                                ? "occupied"
                                : "available"
                    }">

                    ${
                        system.notWorking
                            ? "Temporarily not working"
                            : live
                                ? "Occupied"
                                : "Available"
                    }

                </span>


                <h4>
                    ${esc(system.name)}
                </h4>


                <p>
                    ${esc(
                        system.specs ||
                        "Standard workstation"
                    )}
                </p>


                <p>

                    ${
                        system.notWorking

                            ? `

                                Repair note:
                                ${esc(
                                    system.note ||
                                    "Needs repair"
                                )}

                              `

                            : live

                                ? `

                                    Occupied until
                                    ${dt(
                                        live.endAt
                                    )}

                                  `

                                : "Ready for bookings"

                    }

                </p>


                <button
                    class="btn ${
                        system.notWorking
                            ? "secondary"
                            : "ghost"
                    } toggle-working-btn"
                    data-id="${system.id}">

                    ${
                        system.notWorking
                            ? "Enable System"
                            : "Temporarily Not Working"
                    }

                </button>

            `;


            grid.appendChild(
                card
            );

        }
    );

}



/* =========================================================
   ADMIN OPERATIONS
========================================================= */

function renderAdminOperations(){

    const center =
        getCenter(
            selectedAdminCenterId
        );


    pageTitle(
        "OPERATIONS",
        center
            ? center.name
            : "Operations",
        center
            ? center.city
            : ""
    );


    document
        .getElementById(
            "adminOperationsHeader"
        )
        .innerHTML =

        center

            ? `

                <div
                    class="page-hero compact">

                    <div>

                        <span class="eyebrow">
                            LIVE OPERATIONS
                        </span>

                        <h1>
                            ${esc(center.name)}
                        </h1>

                        <p>
                            Bookings and queue
                            for only this selected center.
                        </p>

                    </div>


                    <button
                        class="btn ghost"
                        data-go="admin-centers">

                        ← Change Center

                    </button>

                </div>

              `

            : "";


    if(!center){

        return;

    }


    const bookings =
        activeBookings()

            .filter(
                booking =>
                    booking.centerId ===
                    center.id
            )

            .sort(
                (a,b) =>
                    a.startAt -
                    b.startAt
            );


    const queue =
        centerQueue(
            center.id
        );


    document.getElementById(
        "adminBookingsTable"
    ).innerHTML = `

        <div class="ops-list">

            ${
                bookings.length

                    ?

                        bookings.map(
                            booking => {

                                const user =
                                    getUser(
                                        booking.userId
                                    );


                                const system =
                                    center.systems.find(
                                        item =>
                                            item.id ===
                                            booking.systemId
                                    );


                                return `

                                    <div
                                        class="operation-item">

                                        <b>

                                            ${esc(
                                                system?.name ||
                                                "System"
                                            )}

                                            ·

                                            ${esc(
                                                user?.name ||
                                                "Customer"
                                            )}

                                        </b>


                                        <span>

                                            ${booking.status.toUpperCase()}

                                            ·

                                            ${dt(
                                                booking.startAt
                                            )}

                                            →

                                            ${dt(
                                                booking.endAt
                                            )}

                                            ·

                                            ${money(
                                                booking.total
                                            )}

                                        </span>

                                    </div>

                                `;

                            }
                        ).join("")

                    :

                    `

                        <div
                            class="empty-state">

                            <span>
                                ✅
                            </span>

                            <h3>
                                No active or future bookings
                            </h3>

                        </div>

                    `
            }

        </div>

    `;


    document.getElementById(
        "adminQueueTable"
    ).innerHTML = `

        <div class="ops-list">

            ${
                queue.length

                    ?

                        queue.map(
                            (entry,index) => {

                                const user =
                                    getUser(
                                        entry.userId
                                    );


                                const slot =
                                    findSlot(
                                        center,
                                        Math.max(
                                            entry.requestedStart,
                                            Date.now()
                                        ),
                                        entry.duration,
                                        entry.preferredSystem
                                    );


                                return `

                                    <div
                                        class="operation-item">

                                        <b>

                                            #${index + 1}

                                            ·

                                            ${esc(
                                                user?.name ||
                                                "Customer"
                                            )}

                                        </b>


                                        <span>

                                            ${dur(
                                                entry.duration
                                            )}

                                            · requested

                                            ${dt(
                                                entry.requestedStart
                                            )}

                                            ·

                                            ${
                                                slot

                                                    ? `

                                                        ${
                                                            esc(
                                                                center.systems.find(
                                                                    system =>
                                                                        system.id ===
                                                                        slot.systemId
                                                                )?.name ||
                                                                "System"
                                                            )
                                                        }

                                                        at

                                                        ${dt(
                                                            slot.startAt
                                                        )}

                                                      `

                                                    : "Pending"
                                            }

                                        </span>

                                    </div>

                                `;

                            }
                        ).join("")

                    :

                    `

                        <div
                            class="empty-state">

                            <span>
                                🎉
                            </span>

                            <h3>
                                No one is waiting
                            </h3>

                        </div>

                    `
            }

        </div>

    `;

}



/* =========================================================
   SYSTEM DETAIL MODAL
========================================================= */

function openSystemModal(
    systemId
){

    const center =
        getCenter(
            selectedAdminCenterId
        );


    const system =
        center?.systems.find(
            item =>
                item.id ===
                systemId
        );


    if(!system){

        return;

    }


    document.getElementById(
        "modalPanel"
    ).innerHTML = `

        <div class="modal-head">

            <div>

                <span class="eyebrow">
                    SYSTEM DETAILS
                </span>

                <h3>
                    ${esc(system.name)}
                </h3>

            </div>


            <button
                class="close"
                data-close>

                ×

            </button>

        </div>


        <div class="modal-grid">

            <div class="field">

                <label>
                    System Name
                </label>

                <input
                    id="mSysName"
                    value="${esc(system.name)}"
                >

            </div>


            <div class="field">

                <label>
                    Specifications
                </label>

                <input
                    id="mSysSpecs"
                    value="${esc(
                        system.specs ||
                        ""
                    )}"
                >

            </div>


            <div class="field wide">

                <label>
                    Admin Note
                </label>

                <textarea
                    id="mSysNote"
                    rows="3">${esc(
                        system.note ||
                        ""
                    )}</textarea>

            </div>


            <div
                class="toggle-line wide">

                <div>

                    <b>
                        Temporarily not working
                    </b>

                    <small class="muted">

                        Disabled systems
                        cannot be booked.

                    </small>

                </div>


                <label
                    class="toggle">

                    <input
                        id="mSysDisabled"
                        type="checkbox"
                        ${
                            system.notWorking
                                ? "checked"
                                : ""
                        }
                    >

                    <span
                        class="slider">
                    </span>

                </label>

            </div>

        </div>


        <div class="modal-actions">

            <button
                class="btn primary"
                id="saveSystem">

                Save System

            </button>

        </div>

    `;


    openModal();


    document
        .getElementById(
            "saveSystem"
        )
        .onclick = () => {

            system.name =
                document
                    .getElementById(
                        "mSysName"
                    )
                    .value
                    .trim() ||
                system.name;


            system.specs =
                document
                    .getElementById(
                        "mSysSpecs"
                    )
                    .value
                    .trim();


            system.note =
                document
                    .getElementById(
                        "mSysNote"
                    )
                    .value
                    .trim();


            system.notWorking =
                document
                    .getElementById(
                        "mSysDisabled"
                    )
                    .checked;


            if(
                system.notWorking &&
                activeBookings().some(
                    booking =>

                        booking.centerId ===
                            center.id &&

                        booking.systemId ===
                            system.id &&

                        (
                            booking.status ===
                                "active" ||

                            booking.status ===
                                "scheduled"
                        )
                )
            ){

                showToast(
                    "This system has an active or future booking and cannot be disabled yet.",
                    "warn"
                );

                return;

            }


            save();


            closeModal();


            showToast(
                "System details saved.",
                "success"
            );


            go(
                "admin-systems"
            );

        };

}



/* =========================================================
   ADD / REMOVE SYSTEMS
========================================================= */

function addSystem(){

    const center =
        getCenter(
            selectedAdminCenterId
        );


    if(!center){

        return;

    }


    if (!window.confirm("Add a new computer system to this hub?")) return;

    center.systems.push({

        id:
            id("sys"),

        name:
            `System ${
                center.systems.length +
                1
            }`,

        notWorking:
            false,

        note:
            "",

        specs:
            "Standard workstation"

    });


    save();


    showToast(
        "Computer system added.",
        "success"
    );


    go(
        "admin-systems"
    );

}



function removeSystem(){
    const center = getCenter(selectedAdminCenterId);
    if (!center) {
        showToast("Select a computer hub first.", "error");
        return;
    }
    if (center.systems.length <= 1) {
        showToast("A computer hub must keep at least one system.", "warn");
        return;
    }
    const removable = center.systems.filter(system =>
        !activeBookings().some(booking =>
            booking.centerId === center.id && booking.systemId === system.id
        )
    );
    if (!removable.length) {
        showToast("Every system has an active or future booking.", "warn");
        return;
    }

    document.getElementById("modalPanel").innerHTML = `
        <div class="modal-head">
            <div><span class="eyebrow">REMOVE SYSTEM</span><h3>Choose a system to remove</h3></div>
            <button class="close" data-close aria-label="Close">×</button>
        </div>
        <p class="modal-help">Booked systems are not listed. Select the exact system you want to remove.</p>
        <div class="field">
            <label for="removeSystemSelect">Computer system</label>
            <select id="removeSystemSelect">
                ${removable.map(system => `<option value="${esc(system.id)}">${esc(system.name)}</option>`).join("")}
            </select>
        </div>
        <div class="modal-actions">
            <button class="btn ghost" data-close>Cancel</button>
            <button class="btn danger" id="confirmRemoveSystem">Remove Selected System</button>
        </div>`;
    openModal();

    document.getElementById("confirmRemoveSystem").onclick = () => {
        const systemId = document.getElementById("removeSystemSelect").value;
        const system = center.systems.find(item => item.id === systemId);
        if (!system) {
            showToast("Please select a valid system.", "error");
            return;
        }
        if (center.systems.length <= 1) {
            showToast("A computer hub must keep at least one system.", "warn");
            closeModal();
            return;
        }
        if (activeBookings().some(booking =>
            booking.centerId === center.id && booking.systemId === system.id
        )) {
            showToast("This system has a booking and cannot be removed.", "warn");
            closeModal();
            return;
        }
        if (!window.confirm(`Are you sure you want to remove "${system.name}"? This action cannot be undone.`)) return;
        center.systems = center.systems.filter(item => item.id !== system.id);
        save();
        closeModal();
        showToast(`${system.name} removed successfully.`, "success");
        go("admin-systems");
    };
}


/* =========================================================
   SESSION / EXTRA TIME
========================================================= */

function openSessionModal(
    bookingId
){

    const booking =
        db.bookings.find(
            item =>

                item.id ===
                    bookingId &&

                item.userId ===
                    currentUser.id
        );


    if(!booking){

        return;

    }


    activeSessionId =
        bookingId;


    const center =
        getCenter(
            booking.centerId
        );


    const queue =
        centerQueue(
            center.id
        );


    document.getElementById(
        "modalPanel"
    ).innerHTML = `

        <div class="modal-head">

            <div>

                <span class="eyebrow">
                    SESSION OPTIONS
                </span>

                <h3>

                    ${
                        booking.status ===
                        "expired"

                            ? "Your booked time has ended"

                            : "Your session is active"
                    }

                </h3>

            </div>


            <button
                class="close"
                data-close>

                ×

            </button>

        </div>


        <div class="bill">

            <div class="bill-line">

                <span>
                    Center
                </span>

                <strong>
                    ${esc(center.name)}
                </strong>

            </div>


            <div class="bill-line">

                <span>
                    System
                </span>

                <strong>

                    ${esc(
                        center.systems.find(
                            system =>
                                system.id ===
                                booking.systemId
                        )?.name ||
                        "System"
                    )}

                </strong>

            </div>


            <div class="bill-line">

                <span>
                    Used duration
                </span>

                <strong>
                    ${dur(
                        booking.duration
                    )}
                </strong>

            </div>


            <div class="bill-line">

                <span>
                    Current charge
                </span>

                <strong>
                    ${money(
                        booking.total
                    )}
                </strong>

            </div>

        </div>


        <div
            class="selected-banner ${
                queue.length
                    ? "warn"
                    : "ok"
            }">

            ${
                queue.length

                    ? "A customer is waiting in the queue, so extra time is not allowed."

                    : "No customer is waiting. Extra time can be granted if it does not collide with a future booking."
            }

        </div>


        <div class="modal-actions">

            <button
                class="btn secondary"
                id="extraTimeBtn"
                ${
                    queue.length
                        ? "disabled"
                        : ""
                }>

                + Extra Time

            </button>


            <button
                class="btn primary"
                id="billNowBtn"
                ${
                    booking.status ===
                    "active"
                        ? "disabled"
                        : ""
                }>

                Generate Bill

            </button>

        </div>

    `;


    openModal();


    document
        .getElementById(
            "extraTimeBtn"
        )
        .onclick =
        extraTime;


    document
        .getElementById(
            "billNowBtn"
        )
        .onclick =
        () =>
            generateBill(
                booking.id
            );

}



function extraTime(){

    const booking =
        db.bookings.find(
            item =>
                item.id ===
                activeSessionId
        );


    if(!booking){

        return;

    }


    const center =
        getCenter(
            booking.centerId
        );


    if(
        centerQueue(
            center.id
        ).length > 0
    ){

        showToast(
            "Extra time is blocked because customers are waiting.",
            "warn"
        );

        return;

    }


    const minutes =
        Number(
            prompt(
                "Extra minutes (15-minute steps)",
                "30"
            )
        );


    if(
        !Number.isFinite(
            minutes
        ) ||
        minutes < 15 ||
        minutes % 15 !== 0
    ){

        showToast(
            "Enter 15, 30, 45... minutes.",
            "error"
        );

        return;

    }


    const newEnd =
        booking.endAt +
        minutes * 60000;


    const conflict =
        activeBookings().some(
            other =>

                other.id !==
                    booking.id &&

                other.centerId ===
                    booking.centerId &&

                other.systemId ===
                    booking.systemId &&

                other.startAt <
                    newEnd &&

                other.endAt >
                    booking.endAt
        );


    if(conflict){

        showToast(
            "Extra time conflicts with a future booking.",
            "warn"
        );

        return;

    }


    booking.duration +=
        minutes;


    booking.endAt =
        newEnd;


    booking.total +=
        charge(
            minutes,
            booking.rate
        );


    booking.status =
        "active";


    save();


    closeModal();


    showToast(
        `Extra ${dur(minutes)} added.`,
        "success"
    );


    go(
        "user-bookings"
    );

}



/* =========================================================
   BILLS
========================================================= */

function generateBill(
    bookingId
){

    const booking =
        db.bookings.find(
            item =>

                item.id ===
                    bookingId &&

                item.userId ===
                    currentUser.id
        );


    if(
        !booking ||
        ![
            "expired",
            "completed"
        ].includes(
            booking.status
        )
    ){

        showToast(
            "The bill is available after the session ends.",
            "warn"
        );

        return;

    }


    let bill =
        db.bills.find(
            item =>
                item.bookingId ===
                booking.id
        );


    const center =
        getCenter(
            booking.centerId
        );


    if(!bill){

        bill = {

            id:
                id("bill"),

            bookingId:
                booking.id,

            userId:
                booking.userId,

            centerId:
                booking.centerId,

            centerName:
                center.name,

            systemId:
                booking.systemId,

            duration:
                booking.duration,

            rate:
                booking.rate,

            total:
                booking.total,

            issuedAt:
                Date.now()

        };


        db.bills.push(
            bill
        );

    }


    booking.status =
        "completed";


    save();


    document.getElementById(
        "modalPanel"
    ).innerHTML = `

        <div class="modal-head">

            <div>

                <span class="eyebrow">
                    BILL
                </span>

                <h3>
                    Computer Usage Bill
                </h3>

            </div>


            <button
                class="close"
                data-close>

                ×

            </button>

        </div>


        <div
            class="bill"
            id="printBill">

            <h3>
                ${esc(
                    bill.centerName
                )}
            </h3>

            <p>
                SlotSync computer usage bill
            </p>


            <div class="bill-line">

                <span>
                    Bill ID
                </span>

                <strong>
                    ${esc(
                        bill.id
                    )}
                </strong>

            </div>


            <div class="bill-line">

                <span>
                    Customer
                </span>

                <strong>
                    ${esc(
                        currentUser.name
                    )}
                </strong>

            </div>


            <div class="bill-line">

                <span>
                    System
                </span>

                <strong>

                    ${esc(
                        center.systems.find(
                            system =>
                                system.id ===
                                bill.systemId
                        )?.name ||
                        "System"
                    )}

                </strong>

            </div>


            <div class="bill-line">

                <span>
                    Duration
                </span>

                <strong>
                    ${dur(
                        bill.duration
                    )}
                </strong>

            </div>


            <div class="bill-line">

                <span>
                    Rate
                </span>

                <strong>
                    ${money(
                        bill.rate
                    )}/hour
                </strong>

            </div>


            <div class="bill-line total">

                <span>
                    Total
                </span>

                <strong>
                    ${money(
                        bill.total
                    )}
                </strong>

            </div>

        </div>


        <div class="modal-actions">

            <button
                class="btn secondary"
                id="printBtn">

                Print

            </button>


            <button
                class="btn primary"
                data-close>

                Done

            </button>

        </div>

    `;


    openModal();


    document
        .getElementById(
            "printBtn"
        )
        .onclick =
        printBill;

}



function printBill(){

    const html =
        document.getElementById(
            "printBill"
        ).outerHTML;


    const windowObject =
        window.open(
            "",
            "_blank",
            "width=480,height=700"
        );


    if(!windowObject){

        return;

    }


    windowObject.document.write(`

        <html>

        <head>

            <title>
                SlotSync Bill
            </title>

            <style>

                body{
                    font-family:Arial;
                    width:380px;
                    margin:30px auto;
                }

                .bill{
                    border:1px dashed #aaa;
                    padding:18px;
                }

                .bill-line{
                    display:flex;
                    justify-content:space-between;
                    padding:9px 0;
                    border-bottom:1px solid #eee;
                    font-size:13px;
                }

                .total{
                    font-size:18px;
                    font-weight:bold;
                    border:0;
                }

            </style>

        </head>

        <body>

            ${html}

            <script>

                window.onload =
                    () =>
                        window.print();

            <\/script>

        </body>

        </html>

    `);


    windowObject.document.close();

}



/* =========================================================
   MODALS
========================================================= */

function openModal(){

    document
        .getElementById(
            "modal"
        )
        .classList.remove(
            "hidden"
        );

}



function closeModal(){

    document
        .getElementById(
            "modal"
        )
        .classList.add(
            "hidden"
        );


    document
        .getElementById(
            "modalPanel"
        )
        .innerHTML =
        "";

}



/* =========================================================
   ADD CENTER
========================================================= */

function openAddCenter(){

    document.getElementById(
        "modalPanel"
    ).innerHTML = `

        <div class="modal-head">

            <div>

                <span class="eyebrow">
                    NEW CENTER
                </span>

                <h3>
                    Add computer hub
                </h3>

            </div>


            <button
                class="close"
                data-close>

                ×

            </button>

        </div>


        <div class="modal-grid">

            <div class="field">

                <label>
                    Name
                </label>

                <input id="nName">

            </div>


            <div class="field">

                <label>
                    Phone
                </label>

                <input id="nPhone">

            </div>


            <div class="field">

                <label>
                    Email
                </label>

                <input
                    id="nEmail"
                    type="email">

            </div>


            <div class="field">

                <label>
                    City
                </label>

                <input id="nCity">

            </div>


            <div class="field wide">

                <label>
                    Address
                </label>

                <textarea id="nAddress"></textarea>

            </div>


            <div class="field">

                <label>
                    PIN
                </label>

                <input id="nPin">

            </div>


            <div class="field">

                <label>
                    Opening Hours
                </label>

                <input
                    id="nHours"
                    value="9:00 AM - 9:00 PM">

            </div>


            <div class="field">

                <label>
                    Computer Rate / Hour
                </label>

                <input
                    id="nRate"
                    type="number"
                    min="1"
                    value="20">

            </div>


            <div class="field">

                <label>
                    System Count
                </label>

                <input
                    id="nSystems"
                    type="number"
                    min="1"
                    max="200"
                    value="10">

            </div>


            <div class="field">

                <label>
                    Latitude
                </label>

                <input
                    id="nLat"
                    type="number"
                    step="any">

            </div>


            <div class="field">

                <label>
                    Longitude
                </label>

                <input
                    id="nLng"
                    type="number"
                    step="any">

            </div>

        </div>


        <div class="modal-actions">

            <button
                class="btn primary"
                id="createCenter">

                Create Center

            </button>

        </div>

    `;


    openModal();


    document
        .getElementById(
            "createCenter"
        )
        .onclick = () => {

            const name =
                document
                    .getElementById(
                        "nName"
                    )
                    .value
                    .trim();


            const rate =
                Number(
                    document
                        .getElementById(
                            "nRate"
                        )
                        .value
                );


            const count =
                Number(
                    document
                        .getElementById(
                            "nSystems"
                        )
                        .value
                );


            const cityValue = document.getElementById("nCity").value.trim();
            const addressValue = document.getElementById("nAddress").value.trim();
            const latValue = document.getElementById("nLat").value.trim();
            const lngValue = document.getElementById("nLng").value.trim();
            const latNumber = Number(latValue);
            const lngNumber = Number(lngValue);

            if(
                !name || !rate || count < 1 || !cityValue || !addressValue ||
                latValue === "" || lngValue === "" ||
                !Number.isFinite(latNumber) || !Number.isFinite(lngNumber) ||
                latNumber < -90 || latNumber > 90 || lngNumber < -180 || lngNumber > 180
            ){

                showToast(
                    "Enter the name, rate, system count, city, address, and valid latitude/longitude.",
                    "error"
                );

                return;

            }


            const center = {

                id:
                    id("c"),

                ownerId:
                    currentUser.id,

                name,

                phone:
                    document
                        .getElementById(
                            "nPhone"
                        )
                        .value
                        .trim(),

                email:
                    document
                        .getElementById(
                            "nEmail"
                        )
                        .value
                        .trim(),

                city: cityValue,

                address: addressValue,

                pin:
                    document
                        .getElementById(
                            "nPin"
                        )
                        .value
                        .trim(),

                hours:
                    document
                        .getElementById(
                            "nHours"
                        )
                        .value
                        .trim(),

                rate,

                status:
                    "open",

                lat: latNumber,
                lng: lngNumber,

                systems:
                    systems(count)

            };


            if (!window.confirm(`Create the computer hub "${center.name}" with ${count} systems at the selected location?`)) return;

            db.centers.push(
                center
            );


            selectedAdminCenterId =
                center.id;


            save();


            closeModal();


            showToast(
                "Computer hub created successfully.",
                "success"
            );


            go(
                "admin-workspace"
            );

        };

}



/* =========================================================
   CANCEL BOOKING
========================================================= */

function cancelBooking(
    bookingId
){

    const booking =
        db.bookings.find(
            item =>
                item.id ===
                bookingId
        );


    if(
        booking &&
        booking.userId ===
            currentUser.id &&
        booking.status ===
            "scheduled" &&
        booking.startAt >
            Date.now()
    ){

        booking.status =
            "cancelled";


        save();


        showToast(
            "Booking cancelled.",
            "success"
        );


        go(
            "user-bookings"
        );

    }

}



/* =========================================================
   LEAVE QUEUE
========================================================= */

function leaveQueue(
    queueId
){

    db.queue =
        db.queue.filter(
            queue =>

                !(
                    queue.id ===
                        queueId &&

                    queue.userId ===
                        currentUser.id
                )
        );


    save();


    showToast(
        "Removed from queue.",
        "success"
    );


    go(
        "user-queue"
    );

}



/* =========================================================
   EVENT DELEGATION
========================================================= */

document.addEventListener(
    "click",
    event => {

        const goButton =
            event.target.closest(
                "[data-go]"
            );


        if(goButton){

            const target =
                goButton.dataset.go;


            if(
                target ===
                    "admin-systems" &&
                !selectedAdminCenterId
            ){

                showToast(
                    "Select a center first.",
                    "warn"
                );

            }

            else if(
                target ===
                    "admin-operations" &&
                !selectedAdminCenterId
            ){

                showToast(
                    "Select a center first.",
                    "warn"
                );

            }

            else{

                go(target);

            }


            return;

        }


        const navButton =
            event.target.closest(
                ".nav-item"
            );


        if(navButton){

            const target =
                navButton.dataset.page;


            if(
                target.startsWith(
                    "admin-"
                ) &&

                target !==
                    "admin-overview" &&

                !selectedAdminCenterId
            ){

                if(
                    target ===
                    "admin-centers"
                ){

                    go(target);

                }

                else{

                    showToast(
                        "Select one of your centers first.",
                        "warn"
                    );

                }

            }

            else{

                go(target);

            }


            return;

        }


        const selectCenter =
            event.target.closest(
                ".select-center"
            );


        if(selectCenter){

            selectedUserCenterId =
                selectCenter.dataset.id;


            go(
                "user-center-detail"
            );


            return;

        }


        const selectAdminCenter =
            event.target.closest(
                ".select-admin-center"
            );


        if(selectAdminCenter){

            selectedAdminCenterId =
                selectAdminCenter.dataset.id;


            go(
                "admin-workspace"
            );


            return;

        }


        const manage =
            event.target.closest(
                ".admin-manage"
            );


        if(manage){

            selectedAdminCenterId =
                manage.dataset.id;


            go(
                "admin-workspace"
            );


            return;

        }


        const systemButton =
            event.target.closest(
                ".book-system"
            );


        if(systemButton){

            openBookingDrawer(
                systemButton.dataset.system
            );


            return;

        }


        if(
            event.target.id ===
            "openBookingBtn"
        ){

            openBookingDrawer();

            return;

        }


        const leave =
            event.target.closest(
                ".leave-queue"
            );


        if(leave){

            leaveQueue(
                leave.dataset.id
            );

            return;

        }


        const cancel =
            event.target.closest(
                ".cancel-btn"
            );


        if(cancel){

            cancelBooking(
                cancel.dataset.id
            );

            return;

        }


        const session =
            event.target.closest(
                ".session-btn"
            );


        if(session){

            openSessionModal(
                session.dataset.id
            );

            return;

        }


        const bill =
            event.target.closest(
                ".bill-btn"
            );


        if(bill){

            generateBill(
                bill.dataset.id
            );

            return;

        }


        if(
            event.target.id ===
            "editCenterBtn"
        ){

            renderEditPanel();

            return;

        }


        if(
            event.target.id ===
                "addCenterBtn" ||

            event.target.id ===
                "addCenterBtnEmpty"
        ){

            openAddCenter();

            return;

        }


        if(
            event.target.id ===
            "addSystemBtn"
        ){

            addSystem();

            return;

        }


        if(
            event.target.id ===
            "removeSystemBtn"
        ){

            removeSystem();

            return;

        }


        const systemDetails =
            event.target.closest(
                ".system-details-btn"
            );


        if(systemDetails){

            openSystemModal(
                systemDetails.dataset.id
            );

            return;

        }


        const toggle =
            event.target.closest(
                ".toggle-working-btn"
            );


        if(toggle){

            const center =
                getCenter(
                    selectedAdminCenterId
                );


            const system =
                center?.systems.find(
                    item =>
                        item.id ===
                        toggle.dataset.id
                );


            if(system){

                if(

                    !system.notWorking &&

                    activeBookings().some(
                        booking =>

                            booking.centerId ===
                                center.id &&

                            booking.systemId ===
                                system.id &&

                            (
                                booking.status ===
                                    "active" ||

                                booking.status ===
                                    "scheduled"
                            )
                    )

                ){

                    showToast(
                        "This system has an active or future booking and cannot be disabled yet.",
                        "warn"
                    );

                    return;

                }


                system.notWorking =
                    !system.notWorking;


                save();


                showToast(

                    system.notWorking

                        ? "System marked temporarily not working."

                        : "System enabled for booking.",

                    "success"

                );


                go(
                    "admin-systems"
                );

            }


            return;

        }


        const close =
            event.target.closest(
                "[data-close]"
            );


        if(close){

            closeModal();

        }

    }
);



/* =========================================================
   AUTH EVENTS
========================================================= */

document
    .querySelectorAll(
        ".role-card"
    )
    .forEach(
        button => {

            button.addEventListener(
                "click",
                () =>
                    selectRole(
                        button.dataset.role
                    )
            );

        }
    );


document
    .getElementById(
        "backRole"
    )
    .addEventListener(
        "click",
        () => {

            document
                .getElementById(
                    "authFormArea"
                )
                .classList.add(
                    "hidden"
                );


            document
                .getElementById(
                    "roleChooser"
                )
                .classList.remove(
                    "hidden"
                );

        }
    );


document
    .getElementById(
        "showLogin"
    )
    .addEventListener(
        "click",
        () => {

            document
                .getElementById(
                    "showLogin"
                )
                .classList.add(
                    "active"
                );


            document
                .getElementById(
                    "showRegister"
                )
                .classList.remove(
                    "active"
                );


            document
                .getElementById(
                    "loginForm"
                )
                .classList.remove(
                    "hidden"
                );


            document
                .getElementById(
                    "registerForm"
                )
                .classList.add(
                    "hidden"
                );

        }
    );


document
    .getElementById(
        "showRegister"
    )
    .addEventListener(
        "click",
        () => {

            document
                .getElementById(
                    "showRegister"
                )
                .classList.add(
                    "active"
                );


            document
                .getElementById(
                    "showLogin"
                )
                .classList.remove(
                    "active"
                );


            document
                .getElementById(
                    "registerForm"
                )
                .classList.remove(
                    "hidden"
                );


            document
                .getElementById(
                    "loginForm"
                )
                .classList.add(
                    "hidden"
                );

        }
    );


document
    .getElementById(
        "loginForm"
    )
    .addEventListener(
        "submit",
        event => {

            event.preventDefault();


            login(

                document
                    .getElementById(
                        "loginEmail"
                    )
                    .value,

                document
                    .getElementById(
                        "loginPassword"
                    )
                    .value

            );

        }
    );


document
    .getElementById(
        "registerForm"
    )
    .addEventListener(
        "submit",
        event => {

            event.preventDefault();


            register(

                document
                    .getElementById(
                        "registerName"
                    )
                    .value,

                document
                    .getElementById(
                        "registerEmail"
                    )
                    .value,

                document
                    .getElementById(
                        "registerPassword"
                    )
                    .value

            );

        }
    );


document
    .getElementById(
        "logoutBtn"
    )
    .addEventListener(
        "click",
        logout
    );


/* USER CENTER SEARCH */

document
    .getElementById(
        "centerSearch"
    )
    .addEventListener(
        "input",
        renderUserCenters
    );


document
    .getElementById(
        "centerSort"
    )
    .addEventListener(
        "change",
        renderUserCenters
    );


/* LOCATION */

document
    .getElementById(
        "useLocationBtn"
    )
    .addEventListener(
        "click",
        () => {

            if(
                !navigator.geolocation
            ){

                showToast(
                    "Geolocation is not supported.",
                    "warn"
                );

                return;

            }


            navigator.geolocation.getCurrentPosition(

                position => {

                    userLocation = {

                        lat:
                            position.coords
                                .latitude,

                        lng:
                            position.coords
                                .longitude

                    };


                    showToast(
                        "Location enabled.",
                        "success"
                    );


                    renderUserCenters();

                },


                () => {

                    showToast(
                        "Location permission was not granted.",
                        "warn"
                    );

                }

            );

        }
    );



/* MODAL CLICK OUTSIDE */

document
    .getElementById(
        "modal"
    )
    .addEventListener(
        "click",
        event => {

            if(
                event.target.id ===
                "modal"
            ){

                closeModal();

            }

        }
    );



/* =========================================================
   CLOCK / LIVE UPDATE
========================================================= */

function updateClock(){

    document
        .getElementById(
            "liveClock"
        )
        .textContent =

        new Date()
            .toLocaleString(
                "en-IN",
                {
                    dateStyle:"medium",
                    timeStyle:"short"
                }
            );

}


updateClock();


setInterval(
    updateClock,
    1000
);


setInterval(
    () => {

        if(!currentUser){

            return;

        }


        updateState();


        const activePage =
            document.querySelector(
                ".page:not(.hidden)"
            )?.id;


        /*
           Don't rebuild Selected Center every second
           while the booking drawer is open.
        */

        if(
            activePage &&
            activePage !==
                "user-center-detail"
        ){

            go(
                activePage
            );

        }

    },
    1000
);



/* =========================================================
   RESTORE SESSION
========================================================= */

const sessionUser =
    localStorage.getItem(
        SESSION_KEY
    );


if(sessionUser){

    currentUser =
        getUser(
            sessionUser
        );


    if(currentUser){

        openApplication();

    }

}
