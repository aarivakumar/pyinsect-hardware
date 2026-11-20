// Website analytics with Google Analytics 4. It records page views, and Google works out the
// visitor's country and state/region from their network address. See the privacy policy (privacy.html).
//
// SET THIS: your GA4 Measurement ID (Google Analytics -> Admin -> Data streams -> your web stream).
// It looks like "G-ABC123DEF4". Until it is set, nothing is sent to Google.
const GA_MEASUREMENT_ID = "G-XXXXXXXXXX";
// Which of our sites this is. Sent with every page view so the reports can be split by site.
const SITE_CODE = "wizkidz-pyinsect";

(function () {
  if (!/^G-[A-Z0-9]{6,}$/.test(GA_MEASUREMENT_ID) || GA_MEASUREMENT_ID === "G-XXXXXXXXXX") {
    console.info("Analytics is off: set GA_MEASUREMENT_ID in analytics.js");
    return;
  }

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };

  const script = document.createElement("script");
  script.async = true;
  script.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_MEASUREMENT_ID;
  document.head.appendChild(script);

  gtag("js", new Date());
  // We send page views ourselves so screens like #home count too, and so the "?..." part
  // of the address (which could hold typed text) is never sent.
  gtag("config", GA_MEASUREMENT_ID, { send_page_view: false, site: SITE_CODE });

  function countPage() {
    gtag("event", "page_view", {
      page_location: location.origin + location.pathname + location.hash,
      page_path: location.pathname + location.hash,
      page_title: document.title,
      site: SITE_CODE,
    });
  }
  countPage();
  window.addEventListener("hashchange", countPage);
})();
