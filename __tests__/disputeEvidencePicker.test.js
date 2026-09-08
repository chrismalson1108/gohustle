// ─────────────────────────────────────────────────────────────────────────────
// The poster's dispute evidence has to survive being picked.
//
// pickImages() has ALWAYS resolved to an object — { canceled } / { canceled,
// denied } / { canceled: false, uris: [...] } — and never to an array
// (src/lib/uploadImage.js, documented in the comment above the export). The
// dispute picker in CompletionModal tested `res?.length` and then spread `res`
// itself, so on every outcome the condition was `undefined`, setDisputePhotos was
// never called, and disputePhotos stayed [].
//
// That is not cosmetic. handleConfirm uploads disputePhotos to completion-photos
// and sends them as `disputePhotos` to stripe-capture-payment, which writes them
// onto the disputes row — while the copy under the picker tells the poster their
// photos "are kept as the record of what happened … and are what support reviews
// if this is escalated". A poster reducing a payout to 50% believed they had
// filed evidence that was never uploaded, on the one screen where the other side
// (the earner, via the finish sheet) CAN attach photos.
//
// The denied branch matters too: refusing camera permission is the one outcome
// the user cannot diagnose, which is why every other caller surfaces it.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const modal = read('src', 'components', 'CompletionModal.js');
const uploader = read('src', 'lib', 'uploadImage.js');

// The picker handler only — so a match elsewhere in a 700-line modal cannot
// stand in for the code that actually runs behind "Add photo".
const handler = (() => {
  const start = modal.indexOf('const res = await pickImages(');
  expect(start).toBeGreaterThan(-1);
  return modal.slice(start, start + 700);
})();

describe('pickImages really does return an object, not an array', () => {
  it('every resolved shape is an object literal', () => {
    // If this ever stops being true the assertions below are guarding nothing.
    expect(uploader).toMatch(/return \{ canceled: true \};/);
    expect(uploader).toMatch(/return \{ canceled: true, denied: true \};/);
    expect(uploader).toMatch(/return \{ canceled: false, uris: result\.assets\.map\(a => a\.uri\) \};/);
    expect(uploader).toMatch(/Returns \{ canceled, denied, uris \}/);
  });

  it('and an object has no length, so the old test could never fire', () => {
    expect({ canceled: false, uris: ['file://a.jpg'] }.length).toBeUndefined();
  });
});

describe("the Verify sheet's dispute picker consumes that contract", () => {
  it('branches on canceled rather than on a length that is never there', () => {
    expect(handler).toMatch(/if \(res\.canceled\)/);
    expect(handler).not.toMatch(/res\?\.length/);
  });

  it('reads the uris off the result instead of spreading the result', () => {
    expect(handler).toMatch(/setDisputePhotos\(prev => \[\.\.\.prev, \.\.\.res\.uris\]\.slice\(0, 6\)\)/);
    expect(handler).not.toMatch(/\[\.\.\.prev, \.\.\.res\]/);
  });

  it('tells the poster when photo access was refused', () => {
    expect(handler).toMatch(/res\.denied/);
    expect(handler).toMatch(/Photos access needed/);
  });
});

describe('the photos the picker now collects are the ones the promise is about', () => {
  it('handleConfirm uploads exactly that state to the private bucket', () => {
    expect(modal).toMatch(/uris: disputePhotos, bucket: 'completion-photos'/);
    expect(modal).toMatch(/disputePhotos: disputed \? photoPaths : undefined/);
  });

  it('and the server stores them on the dispute row', () => {
    const capture = read('supabase', 'functions', '_shared', 'settleEscrow.ts')
      + '\n' + read('supabase', 'functions', 'stripe-capture-payment', 'index.ts');
    expect(capture).toMatch(/disputeReason, disputePhotos \} = await req\.json\(\)/);
    expect(capture).toMatch(/Array\.isArray\(disputePhotos\)/);
  });

  it('the copy that made this a broken promise is still on screen', () => {
    // If this line is ever softened the test above is still correct, but the
    // reason this was filed as high rather than cosmetic lives here.
    expect(modal).toMatch(/are what support reviews if this is escalated/);
  });
});
