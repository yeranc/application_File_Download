sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageBox",
    "sap/ui/core/BusyIndicator",
    "sap/m/MessageToast"
], function (Controller, JSONModel, Filter, FilterOperator, MessageBox, BusyIndicator, MessageToast) {
    "use strict";

    return Controller.extend("zal11.down.zfiledownload.controller.Home", {
        /**
        * Lifecycle hook – called when controller is initialized.
        */
        onInit: function () {
            const oViewModel = new JSONModel({
                directory: "/tmp",
                createdOn: ""
            });
            this.getView().setModel(oViewModel, "viewModel");

            const oModel = this.getOwnerComponent().getModel("AL11Files");
            this.getView().setModel(oModel);

            // Get the service URL from the AL11Files Model
            this._sServiceUrl = oModel.sServiceUrl.replace(/\/$/, "");

            const oSmartTable = this.byId("smartTable");

            // Attach beforeRebind handler once - ensures filters are applied every time table rebinds
            oSmartTable.attachBeforeRebindTable(this._onBeforeRebindTable, this);

            // Wait until SmartTable creates inner table to enable multiselect
            oSmartTable.attachInitialise(function () {
                const oTable = oSmartTable.getTable();
                oTable.setMode("MultiSelect");
            });
        },

        /**
        * SmartTable beforeRebind handler.
        * This method dynamically builds filters based on latest UI values.
        * It runs automatically every time rebindTable() is triggered.
        */
        _onBeforeRebindTable: function (oEvent) {
            const oBindingParams = oEvent.getParameter("bindingParams");
            const oViewModel = this.getView().getModel("viewModel");
            const sDirectory = oViewModel.getProperty("/directory");
            const oDatePicker = this.byId("datePicker");
            const oSelectedDate = oDatePicker.getDateValue();

            const aFilters = [];

            if (sDirectory) {
                aFilters.push(new Filter("Directory", FilterOperator.EQ, sDirectory));
            }

            // Creates date in UTC range: 00:00:00 to 23:59:59 as GUI follows UTC
            if (oSelectedDate) {
                const oFromDate = new Date(Date.UTC(
                    oSelectedDate.getFullYear(),
                    oSelectedDate.getMonth(),
                    oSelectedDate.getDate(),
                    0, 0, 0
                ));
                const oToDate = new Date(Date.UTC(
                    oSelectedDate.getFullYear(),
                    oSelectedDate.getMonth(),
                    oSelectedDate.getDate(),
                    23, 59, 59
                ));

                aFilters.push(new Filter({
                    filters: [
                        new Filter("Created_Raw", FilterOperator.GE, oFromDate),
                        new Filter("Created_Raw", FilterOperator.LE, oToDate)
                    ],
                    and: true
                }));
            }

            // Assign the filters to bindingParams
            oBindingParams.filters = aFilters;

            oBindingParams.parameters = oBindingParams.parameters || {};
            oBindingParams.parameters.countMode = "Inline";
        },

        /**
        * Search button handler.
        * Validates input and triggers SmartTable rebind.
        */
        onSearch: function () {
            const oViewModel = this.getView().getModel("viewModel");
            const sDirectory = oViewModel.getProperty("/directory");

            if (!sDirectory) {
                MessageBox.error("Please enter a directory.");
                return;
            }

            // Trigger rebind — filters handled in _onBeforeRebindTable
            this.byId("smartTable").rebindTable();
        },

        _getSelectedFileContexts: function () {
            const oSmartTable = this.byId("smartTable");
            const oTable = oSmartTable.getTable();
            const aSelectedItems = oTable.getSelectedItems();
            return aSelectedItems
                .map(item => item.getBindingContext())
                .filter(Boolean);
        },

        onDownload: async function () {
            const sServiceUrl = this._sServiceUrl;
            const selectedFiles = this._getSelectedFileContexts();
            if (!selectedFiles.length) {
                MessageToast.show("Select at least one file.");
                return;
            }

            const files = selectedFiles.map((oContext) => {
                const oObject = oContext.getObject();
                const sPath = oContext.getPath();
                const oMatch = sPath.match(/File_Size=(\d+)/);
                return {
                    ...oObject,
                    File_Size: oMatch ? parseInt(oMatch[1], 10) : null   // Include the file size
                };
            });

            BusyIndicator.show(0);
            try {
                // Fetch CSRF token once, pass it to all downloads
                const sCsrfToken = await fetchCsrfToken(sServiceUrl);

                if (files.length === 1) {
                    const blob = await fetchBlobSmart(files[0], sCsrfToken, sServiceUrl);
                    saveBlob(blob, files[0].File_Name || "file");
                    MessageToast.show(`File "${files[0].File_Name}" downloaded successfully`);
                    return;
                }
                const JSZip = await ensureJSZip();
                const zip = new JSZip();
                for (const f of files) {
                    const b = await fetchBlobSmart(f, sCsrfToken, sServiceUrl);
                    zip.file(f.File_Name || "file", b);
                }
                const zipBlob = await zip.generateAsync({ type: "blob" });
                saveBlob(zipBlob, `files_${timestamp()}.zip`);
                MessageToast.show(`${files.length} files downloaded successfully`);

            } catch (e) {
                if (e && e.isFileNotExists) {
                    const sFileName = files.length === 1 ? files[0].File_Name : (e.fileName || "");
                    MessageBox.error(`File "${sFileName}" couldn't be opened.`);
                } else {
                    MessageToast.show("Download failed: " + (e.message || ""));
                }
            } finally {
                BusyIndicator.hide();
            }
        },
    });
    async function fetchCsrfToken(sServiceUrl) {
        return new Promise((resolve, reject) => {
            jQuery.ajax({
                url: `${sServiceUrl}/`,
                method: "GET",
                headers: { "X-CSRF-Token": "Fetch" },
                success: function (data, status, xhr) {
                    const sToken = xhr.getResponseHeader("X-CSRF-Token");
                    sToken ? resolve(sToken) : reject(new Error("CSRF token not returned."));
                },
                error: function (oXhr) {
                    let message = "Error fetching the CSRF Token";
                    try {
                        const json = JSON.parse(oXhr.responseText);
                        message = json.error.message.value;
                    } catch (e) { }
                    reject(new Error(message));
                }
            });
        });
    }
    async function tryFetchBlob(url, sCsrfToken) {
        return new Promise((resolve, reject) => {
            jQuery.ajax({
                url: url,
                method: "POST",
                headers: {
                    "X-CSRF-Token": sCsrfToken,
                    "Accept": "application/xml"
                },
                success: function (oData) {
                    const sXml = (typeof oData !== "string")
                        ? new XMLSerializer().serializeToString(oData)
                        : oData;

                    const oXmlDoc = new DOMParser().parseFromString(sXml, "application/xml");
                    const getTagText = (tag) => {
                        const tags = oXmlDoc.getElementsByTagName("*");
                        for (let i = 0; i < tags.length; i++) {
                            if (tags[i].localName === tag) return tags[i].textContent;
                        }
                        return "";
                    };

                    const sBase64Raw = getTagText("Attachment");
                    if (!sBase64Raw) {
                        reject(new Error("No attachment data in response"));
                        return;
                    }

                    // Strip whitespace — SAP sometimes line-wraps base64 in XML
                    const sBase64 = sBase64Raw.replace(/\s+/g, "");

                    let sBinary;
                    try {
                        sBinary = atob(sBase64);
                    } catch (e) {
                        reject(new Error("Base64 decode failed: " + e.message));
                        return;
                    }

                    // Convert binary string to Uint8Array
                    const aBytes = new Uint8Array(sBinary.length);
                    for (let i = 0; i < sBinary.length; i++) {
                        aBytes[i] = sBinary.charCodeAt(i);
                    }

                    resolve(new Blob([aBytes], { type: "application/octet-stream" }));
                },
                error: function (oXhr) {
                    const sResponse = oXhr.responseText || "";
                    if (sResponse.includes("DATASET_NOT_OPEN")) {
                        const oErr = new Error("FILE_NOT_EXISTS");
                        oErr.isFileNotExists = true;
                        reject(oErr);
                        return;
                    }
                    reject(new Error(`HTTP ${oXhr.status}: ${oXhr.statusText}`));
                }
            });
        });
    }
    async function fetchBlobSmart(file, sCsrfToken, sServiceUrl) {
        const { File_Name, File_Path, File_Size } = file;
        const candidates = [buildStrictUrl(sServiceUrl, File_Name, File_Path, File_Size)];
        let lastErr;
        for (const c of candidates) {
            try {
                return await tryFetchBlob(c, sCsrfToken);
            }
            catch (e) {
                lastErr = e;
            }
        }
        throw lastErr;
    }
    function buildStrictUrl(sServiceUrl, name, path, size) {
        const enc = (s) => encodeURIComponent(String(s));
        return `${sServiceUrl}/get_Results?`
            + `&File_Name='${enc(name)}'`
            + `&File_Path='${enc(path)}'`
            + `&File_Size=${size || 0}`;
    }
    function saveBlob(blob, filename) {
        const a = document.createElement("a");
        const url = URL.createObjectURL(blob);
        a.href = url; a.download = filename || "file";
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
    }
    function ensureJSZip() {
        if (window.JSZip) return Promise.resolve(window.JSZip);
        return new Promise(function (resolve, reject) {
            const s = document.createElement("script");
            // Get the zip library from the libs folder under webapp
            s.src = sap.ui.require.toUrl("zal11/down/zfiledownload") + "/libs/jszip.min.js";
            s.onload = function () {
                window.JSZip
                    ? resolve(window.JSZip)
                    : reject(new Error("JSZip loaded but not available on window"));
            };
            s.onerror = () => reject(new Error("Failed to load JSZip"));
            document.head.appendChild(s);
        });
    }
    function timestamp() {
        const d = new Date(); const pad = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    }
});
