<!DOCTYPE html>
<html>
  <head>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.2.0/dist/css/bootstrap.min.css" rel="stylesheet" crossorigin="anonymous">
    <meta charset="utf-8">
    <title>Add Map</title>
    <script src="https://polyfill.io/v3/polyfill.min.js?features=default"></script>
    <style>
/* Set the size of the div element that contains the map */
#map {
  height: 600px;
  /* The height is 400 pixels */
  width: 100%;
  /* The width is the width of the web page */
}
    </style>
  </head>
  <body>
    <h2>🦆🕵🏿 wd intel</h2>
    <h3>Використано файли:</h3>
    <div class="mb-2 mt-2">
      <ul>
{used_files_list_s}
      </ul>
    </div>
    <!--The div element for the map -->
    <div id="map"></div>

    <script
      src="https://maps.googleapis.com/maps/api/js?key={apikey}&callback=initMap&v=weekly"
      defer
    ></script>
    <script>
// Initialize and add the map
function initMap() {
  const map = new google.maps.Map(document.getElementById("map"), {
    zoom: 7,
    center: {lat: 47.62818291142614, lng: 35.32983702859112},
  });
  let coord_results = {coord_results};
  console.log("> coord_results: ", coord_results);
  const infoWindow = new google.maps.InfoWindow();

  for (const i in coord_results) {
      let res = coord_results[i];

      const marker = new google.maps.Marker({
        position: {lat: res.x, lng: res.y},
        map: map,
        title: res.info,
        // label: res.label,
      });

      // Add a click listener for each marker, and set up the info window.
      marker.addListener("click", () => {
        infoWindow.close();
        infoWindow.setContent(marker.getTitle());
        infoWindow.open(marker.getMap(), marker);
      });
  }
}

window.initMap = initMap;
    </script>
  </body>
</html>
