
import '@shoelace-style/shoelace/dist/themes/light.css';

import '@shoelace-style/shoelace/dist/components/popup/popup.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/radio-button/radio-button.js';
import '@shoelace-style/shoelace/dist/components/radio-group/radio-group.js';
import "bootstrap/dist/js/bootstrap.bundle.min.js"
import "bootstrap/dist/css/bootstrap.css"
import { inverse, forward } from "mgrs"
import { td_usk2000_to_wgs84, td_wgs84_to_usk2000 } from "./ts/utils"
import "./ts/web-components/bar-chart"
import "./style.css"
import { setupMap, addPointsToLayer } from './ts/maps/maps'
import { MapPoint, MapPointDetailed, MapPointShort } from './ts/maps/types'
import './ts/web-components/analysis-map'
import './ts/web-components/modal-dialog.ts'
import './ts/web-components/bar-chart-2.ts'
import './ts/web-components/small-map.ts'

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';


dayjs.extend(utc);
dayjs.extend(timezone);

function td_propose_icons(search, description) {
	return search.search(description).map((x: any) => x.icon).slice(0, 8);
};
async function loadDescriptionIconTitle(search) {
	const response = await fetch('/data/description-icon-title.json');
	const documents = await response.json();
	search.addDocuments(documents);
}
let search: any = null;
import('../static/js-search').then(module => {
	search = new module.Search('icon');
	search.addIndex('title');
	search.addIndex('descrption');
	search.addIndex('icon');




	if (window.location.pathname.endsWith("/importer")) {
		loadDescriptionIconTitle(search)
	} else {
		if (window.navigation) {
			const navHandler = async (event) => {
				if (event.destination.url.endsWith("/importer")) {
					await loadDescriptionIconTitle(search)
					window.navigation.removeEventListener("navigate", navHandler);
				}
			}

			window.navigation.addEventListener("navigate", navHandler)

		} else {
			// fallback for firefox and safari (Navigation API is not implemented there yet)
			loadDescriptionIconTitle(search)
		}
	}
})





// This is called BEFORE your Elm app starts up
// 
// The value returned here will be passed as flags 
// into your `Shared.init` function.
export const flags = ({ env }) => {
	const isDark = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
	const now = dayjs().tz('Europe/Kiev').valueOf();
	return { "isDark": isDark, now };

}

// This is called AFTER your Elm app starts up
//
// Here you can work with `app.ports` to send messages
// to your Elm application, or subscribe to incoming
// messages from Elm
export const onReady = ({ app, env }) => {

	const isDark = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
	if (isDark) {
		document.documentElement.setAttribute("data-bs-theme", "dark");
	}

	if (app.ports && app.ports.home_usk2000ToWgs84 && app.ports.home_usk2000ToWgs84Res) {
		app.ports.home_usk2000ToWgs84.subscribe(({ coords }) => {
			let res = td_usk2000_to_wgs84(coords);
			let res_latlng = { lat: res.x, lng: res.y };
			let arg = { coords: res_latlng };
			app.ports.home_usk2000ToWgs84Res.send(arg);
		});
	}

	if (app.ports && app.ports.home_mgrsToWgs84 && app.ports.home_mgrsToWgs84Res) {
		app.ports.home_mgrsToWgs84.subscribe(({ coords }) => {
			let res = inverse(coords);
			let res_latlng = { lat: res[1], lng: res[0] };
			let arg = { coords: res_latlng };
			app.ports.home_mgrsToWgs84Res.send(arg);
		});
	}

	if (app.ports && app.ports.home_wgs84ToUsk2000 && app.ports.home_wgs84ToUsk2000Res) {
		app.ports.home_wgs84ToUsk2000.subscribe(({ coords }) => {
			let res = td_wgs84_to_usk2000({ y: coords.lat, x: coords.lng });
			let res_xy = { x: Math.round(res.y), y: Math.round(res.x) };
			let arg = { coords: res_xy };
			app.ports.home_wgs84ToUsk2000Res.send(arg);
		});
	}

	if (app.ports && app.ports.home_wgs84ToMgrs && app.ports.home_wgs84ToMgrsRes) {
		app.ports.home_wgs84ToMgrs.subscribe(({ coords, viewId }) => {
			let res = forward([coords.lng, coords.lat]);
			let arg = { coords: res, viewId };
			app.ports.home_wgs84ToMgrsRes.send(arg);
		});
	}

	if (app.ports && app.ports.importer_usk2000ToWgs84 && app.ports.importer_usk2000ToWgs84Res) {
		app.ports.importer_usk2000ToWgs84.subscribe(({ rowId, coordId, coords }) => {
			let res = td_usk2000_to_wgs84(coords);
			let res_latlng = { lat: res.x, lng: res.y };
			let arg = {
				rowId: rowId,
				coordId: coordId,
				coords: res_latlng
			};
			app.ports.importer_usk2000ToWgs84Res.send(arg);
		});
	}

	if (app.ports && app.ports.importer_proposeIcons && app.ports.importer_proposeIconsRes) {
		app.ports.importer_proposeIcons.subscribe(({ rowId, text }) => {
			let res = td_propose_icons(search, text);
			let arg = {
				rowId: rowId,
				icons: res
			};
			app.ports.importer_proposeIconsRes.send(arg);
		});
	}

	let td_arrayBufferToBase64 = function(buffer) {
		let binary = '';
		let bytes = new Uint8Array(buffer);
		let len = bytes.byteLength;
		for (let i = 0; i < len; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return window.btoa(binary);
	}

	if (app.ports && app.ports.importer_pasteImage && app.ports.importer_pasteImageRes) {
		app.ports.importer_pasteImage.subscribe(({ rowId }) => {
			navigator.clipboard.read().then((contents) => {
				for (const item of contents) {
					if (item.types.includes('image/png')) {
						item.getType('image/png').then((blob) => {
							blob.arrayBuffer().then((arr) => {
								let contentsBase64 = td_arrayBufferToBase64(arr);
								let arg = { rowId: rowId, contentsBase64: contentsBase64 };
								app.ports.importer_pasteImageRes.send(arg);
							});
						});
					}
				}
			});
		});
	}

	if (app.ports && app.ports.rer_importer_focus) {
		app.ports.rer_importer_focus.subscribe(({ elemId }) => {
			requestAnimationFrame(
				() => {
					document.getElementById(elemId)?.focus();
				});
		});
	}

	if (app.ports && app.ports.port_focusHtmlElement) {
		app.ports.port_focusHtmlElement.subscribe(({ elemId }) => {
			requestAnimationFrame(
				() => {
					document.getElementById(elemId)?.focus();
				});
		});
	}

	if (app.ports && app.ports.port_scrollToElement) {
		app.ports.port_scrollToElement.subscribe(({ elemId, x, y }) => {
			requestAnimationFrame(
				() => {
					let el = document.getElementById(elemId);
					el?.scrollTo({ top: y, left: x, behavior: "instant" });
				});
		});
	}

	if (app.ports && app.ports.waterfall_scrollIntoView) {
		app.ports.waterfall_scrollIntoView.subscribe(({ elemId, height, waterfallId }) => {
			requestAnimationFrame(
				() => {
					const el = document.getElementById(elemId);
					const waterfall = document.getElementById(waterfallId);
					if (el) {
						const notVisibleHeight = el.offsetHeight - height

						el.scrollIntoView({ behavior: "instant", block: "start", inline: "nearest" });

						if (waterfall) {
							waterfall.scrollBy({ behavior: "instant", top: notVisibleHeight })
						}
					}

				});
		});

	}
	if (app.ports && app.ports.waterfall_scrollTo) {
		app.ports.waterfall_scrollTo.subscribe(({ elemId, x, y }) => {
			requestAnimationFrame(
				() => {
					let el = document.getElementById(elemId);
					el?.scrollTo({ top: y, left: x, behavior: "instant" });
				});
		});
	}

	if (app.ports && app.ports.waterfall_copyTextToClipboard) {
		app.ports.waterfall_copyTextToClipboard.subscribe(({ text }) => {
			if (!navigator.clipboard) {
			} else {
				navigator.clipboard.read().then((contents) => {
					if (!navigator.clipboard) {
					} else {
						navigator.clipboard.writeText(text).then(() => { });
					}
				});
			}
		});
	}

	if (app.ports && app.ports.waterfall_getVisibleMsgIds && app.ports.waterfall_getVisibleMsgIdsRes) {
		app.ports.waterfall_getVisibleMsgIds.subscribe(({ waterfallId, allMsgIds }: { waterfallId: string, allMsgIds: number[] }) => {
			const waterfallElement = document.getElementById(`waterfall-${waterfallId}`);

			if (waterfallElement) {

				const waterfallPosTop = waterfallElement.getBoundingClientRect().top;

				const viewportTop = window.scrollY + waterfallPosTop;
				const viewportBottom = viewportTop + window.innerHeight;

				const isVisible = (index) => {
					const msgId = allMsgIds[index];
					const elem = document.getElementById(`waterfall-${waterfallId}-message-${msgId}`);

					if (elem) {
						const elemTop = elem.getBoundingClientRect().top + window.scrollY;
						const elemBottom = elemTop + elem.offsetHeight;

						const isPartiallyVisible = (elemBottom > viewportTop) && (elemTop < viewportBottom);

						const visibleTop = Math.max(elemTop, viewportTop)
						const visibleBottom = Math.min(elemBottom, viewportBottom)
						const visibleHeight = Math.max(0, visibleBottom - visibleTop)

						return {
							visible: isPartiallyVisible,
							elemTop,
							elemBottom,
							visibleHeight
						};
					}
					return { visible: false, elemTop: null, elemBottom: null, visibleHeight: 0 };
				};

				const findVisibleTopToBottom = (index) => {
					let bottom = index;
					let top = index;

					while (isVisible(bottom - 1).visible && bottom >= 0) {
						bottom--;
					}
					while (isVisible(top + 1).visible && top < allMsgIds.length) {
						top++;
					}

					return { bottom, top };
				};

				const visibleMsgIds: number[] = [];
				let firstVisibleIndex: number;

				let left = 0
				let right = allMsgIds.length - 1

				while (left <= right) {
					const mid = Math.floor((left + right) / 2)
					const currentMessage = isVisible(mid);

					if (currentMessage.visible) {
						const { bottom, top } = findVisibleTopToBottom(mid);
						for (let j = bottom; j <= top; j++) {
							visibleMsgIds.push(allMsgIds[j]);
						}
						firstVisibleIndex = bottom;
						break;
					}

					if (currentMessage.elemTop !== null && currentMessage.elemTop >= viewportTop) {
						right = mid - 1
					} else {

						left = mid + 1
					}

				}
				//@ts-ignore 
				const firstMessageVisibility = isVisible(firstVisibleIndex);
				const firstVisibleHeight = firstMessageVisibility.visible ? firstMessageVisibility.visibleHeight : 0;

				app.ports.waterfall_getVisibleMsgIdsRes.send({ waterfallId, msgIds: visibleMsgIds, firstVisibleHeight });
			}
		});
	}

	window.netjson_graphs = {};

	let scriptLoaded = false;

	const loadScript = () => {
		if (!scriptLoaded) {
			scriptLoaded = true;
			return import("../static/netjsongraph/netjsongraph.min.js")
		}
		return Promise.resolve();
	};
	if (app.ports && app.ports.port_initNetjsonGraph) {
		app.ports.port_initNetjsonGraph.subscribe(({ elemId, graphDataAndMeta }) => {
			loadScript().then(() => {
				let graphData = graphDataAndMeta.graph;
				graphData.type = graphData.type_;

				let graph;
				if (elemId in window.netjson_graphs) {
					graph = window.netjson_graphs[elemId];
					graph.utils.JSONDataUpdate(graphData);
				} else {
					graph = new NetJSONGraph(graphData, {
						el: document.getElementById(elemId),
						graphConfig: {
							series: {
								nodeSize: (node) => {
									if (node.count <= 20) {
										return Math.sqrt(node.count) * 4;
									} else {
										return 20 + Math.log(node.count);
									}
								}
							},
							baseOptions: {
								backgroundColor: "#211a11",
							}
						},
						linkCategories: graphDataAndMeta.linkCategories,
					});
				}
				graph.render();

			})
		});

	}

	if (app.ports && app.ports.shared_toggleDarkMode) {
		app.ports.shared_toggleDarkMode.subscribe(() => {
			const htmlElement = document.documentElement; // Get the <html> element

			if (!htmlElement.getAttribute("data-bs-theme")) {
				htmlElement.setAttribute("data-bs-theme", "dark"); // Set the attribute to "dark"
			} else {
				htmlElement.removeAttribute("data-bs-theme"); // Remove the attribute
			}
		});
	}


	if (app.ports && app.ports.shared_getLocation && app.ports.shared_getLocationRes) {
		app.ports.shared_getLocation.subscribe(() => {
			let loc = window.location;
			let res = {
				host: loc.host,
				hostname: loc.hostname,
				href: loc.href,
				origin: loc.origin,
				pathname: loc.pathname,
				port_: loc.port,
				protocol: loc.protocol,
				search: loc.search,
				hash: loc.hash
			};
			app.ports.shared_getLocationRes.send(res);
		});
	}

	if (app.ports && app.ports.importer_mgrsToWgs84 && app.ports.importer_mgrsToWgs84Res) {
		app.ports.importer_mgrsToWgs84.subscribe(({ rowId, coordId, coords }) => {
			let res = inverse(coords);
			let res_latlng = { lat: res[1], lng: res[0] };
			let arg = {
				rowId: rowId,
				coordId: coordId,
				coords: res_latlng
			};
			app.ports.importer_mgrsToWgs84Res.send(arg);
		});
	}

	if (app.ports && app.ports.shared_loadScript) {
		let presentScripts = document.getElementsByTagName('script');
		app.ports.shared_loadScript.subscribe(function(url) {
			for (let i = 0; i < presentScripts.length; i++) {
				if (presentScripts[i].src.endsWith(url)) {
					app.ports.shared_loadScriptRes.send(url);
					return;
				}
			};

			const script = document.createElement('script');
			script.src = url;
			script.onload = function() {
				app.ports.shared_loadScriptRes.send(url);
				presentScripts = document.getElementsByTagName('script');
			};
			document.body.appendChild(script);
		});
	}


	if (app.ports && app.ports.rer_freqs_openMap && app.ports.rer_freqs_closeMapRes) {
		app.ports.rer_freqs_openMap.subscribe(function(data: { points: MapPointShort[]; containerId: string }) {
			if (data.points.length > 0) {
				setupMap(data, () => app.ports.rer_freqs_closeMapRes.send(data.containerId))
			}
		});

	}

}
