// Helpers called on the main test HTMLs.
// Functions in `RemoteWindow.executeScript()`'s 1st argument are evaluated
// on the executors (`executor.html`), and helpers available on the executors
// are defined in `executor.html`.

const originSameOrigin =
  location.protocol === 'http:' ?
  'http://{{host}}:{{ports[http][0]}}' :
  'https://{{host}}:{{ports[https][0]}}';
const originSameSite =
  location.protocol === 'http:' ?
  'http://{{host}}:{{ports[http][1]}}' :
  'https://{{host}}:{{ports[https][1]}}';
const originCrossSite =
  location.protocol === 'http:' ?
  'http://{{hosts[alt][www]}}:{{ports[http][0]}}' :
  'https://{{hosts[alt][www]}}:{{ports[https][0]}}';

const executorPath =
  '/html/browsers/browsing-the-web/back-forward-cache/resources/executor.html?uuid=';

// Asserts that the executor `target` is (or isn't, respectively)
// restored from BFCache. These should be used in the following fashion:
// 1. Call prepareNavigation() on the executor `target`.
// 2. Navigate the executor to another page.
// 3. Navigate back to the executor `target`.
// 4. Call assert_bfcached() or assert_not_bfcached() on the main test HTML.

async function assert_bfcached(target) {
  const status = await getBFCachedStatus(target);
  assert_implements_optional(status === 'BFCached', 'Should be BFCached');
}

async function assert_not_bfcached(target) {
  const status = await getBFCachedStatus(target);
  assert_implements_optional(status !== 'BFCached', 'Should not be BFCached');
}

async function getBFCachedStatus(target) {
  const resp = await target.executeScript(() => [window.loadCount, window.isPageshowFired]);
  const [loadCount, isPageshowFired] = resp.toLocal();
  if (loadCount === 1 && isPageshowFired === true) {
    return 'BFCached';
  } else if (loadCount === 2 && isPageshowFired === false) {
    return 'Not BFCached';
  } else {
    // This can occur for example when this is called before first navigating
    // away (loadCount = 1, isPageshowFired = false), e.g. when
    // 1. sending a script for navigation and then
    // 2. calling getBFCachedStatus() without waiting for the completion of
    //    the script on the `target` page.
    assert_unreached(
      `Got unexpected BFCache status: loadCount = ${loadCount}, ` +
      `isPageshowFired = ${isPageshowFired}`);
  }
}

// Always call `await remoteContext.executeScript(waitForPageShow);` after
// triggering to navigation to the page, to wait for pageshow event on the
// remote context.
const waitForPageShow = () => {
    console.log("waitForPageShow");
    return window.pageShowPromise;
}

// Run a test that navigates A->B->A:
// 1. Page A is opened by `params.openFunc(url)`.
// 2. `params.funcBeforeNavigation` is executed on page A.
// 3. The window is navigated to page B on `params.targetOrigin`.
// 4. The window is back navigated to page A (expecting BFCached).
//
// Events `params.events` (an array of strings) are observed on page A and
// `params.expectedEvents` (an array of strings) is expected to be recorded.
// See `event-recorder.js` for event recording.
//
// Parameters can be omitted. See `defaultParams` below for default.
function runEventTest(params, description) {
  const defaultParams = {
    openFunc: url => window.open(url, '_blank', 'noopener'),
    funcBeforeNavigation: () => {},
    targetOrigin: originCrossSite,
    events: ['pagehide', 'pageshow', 'load'],
    expectedEvents: [
      'window.load',
      'window.pageshow',
      'window.pagehide.persisted',
      'window.pageshow.persisted'
    ],
  };
  // Apply defaults.
  params = {...defaultParams, ...params};

  promise_test(async t => {
    const pageA = new RemoteWindow();
    const pageB = new RemoteWindow();

    t.add_cleanup(() => {
        return Promise.all([pageA.close(), pageB.close()]);
    });

    console.log(`pageA uuid ${pageA.uuid}`);
    console.log(`pageB uuid ${pageB.uuid}`);

    const urlA = executorPath + pageA.uuid +
                 '&events=' + params.events.join(',');
    const urlB = params.targetOrigin + executorPath + pageB.uuid;

    params.openFunc(urlA);

    console.log("pageA.waitForPageShow 1");
    await pageA.executeScript(waitForPageShow);
    console.log("pageA.funcBeforeNavigation");
    await pageA.executeScript(params.funcBeforeNavigation);
    console.log("pageA.prepareNavigation");
    await pageA.executeScriptNoResult(
      (url) => {
        prepareNavigation(() => {
          console.log(`Navigating to ${url}`);
          location.href = url;
        });
      },
      [urlB]
    );

    console.log("pageB.waitForPageShow");
    await pageB.executeScript(waitForPageShow);
    console.log("pageB.prepareNavigation");
    await pageB.executeScriptNoResult(
      () => {
        prepareNavigation(() => {
            console.log(`Navigating back`);
            history.back();
        });
      }
    );

    console.log("pageA.waitForPageShow 2");
    await pageA.executeScript(waitForPageShow);
    console.log("pageA.assert_bfcached");
    await assert_bfcached(pageA);

    console.log("pageA.getRecordedEvents");
    assert_array_equals(
      (await pageA.executeScript(() => getRecordedEvents())).toLocal(),
      params.expectedEvents);
  }, description);
}
