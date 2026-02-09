/**
 * Audio file loading, playback, and AudioContext/AnalyserNode management.
 *
 * Wraps an <audio> element with file-picker UI (click + drag-and-drop),
 * play/pause, seek-bar, time display, and playlist navigation.
 * Lazily creates the AudioContext and stereo AnalyserNodes on first file load.
 *
 * Extends EventTarget and fires:
 *   - "play"        when playback starts
 *   - "pause"       when playback is paused
 *   - "ended"       when the last track finishes (no more tracks to advance)
 *   - "trackchange" when the current track changes
 */
export class AudioPlayer extends EventTarget {
  #audio = new Audio();
  #audioCtx = null;
  #analyser = null;
  #analyserL = null;
  #analyserR = null;
  #sourceNode = null;
  #seeking = false;

  /** @type {{ name: string, url: string }[]} */
  #tracks = [];
  #currentIndex = -1;

  // DOM refs
  #$fileArea;
  #$fileInput;
  #$fileName;
  #$btnPlay;
  #$btnPrev;
  #$btnNext;
  #$seekBar;
  #$timeLabel;
  #$trackList;

  /**
   * @param {{
   *   fileArea: HTMLElement,
   *   fileInput: HTMLInputElement,
   *   fileName: HTMLElement,
   *   btnPlay: HTMLButtonElement,
   *   btnPrev: HTMLButtonElement,
   *   btnNext: HTMLButtonElement,
   *   seekBar: HTMLInputElement,
   *   timeLabel: HTMLElement,
   *   trackList: HTMLElement,
   * }} els
   */
  constructor(els) {
    super();
    this.#$fileArea = els.fileArea;
    this.#$fileInput = els.fileInput;
    this.#$fileName = els.fileName;
    this.#$btnPlay = els.btnPlay;
    this.#$btnPrev = els.btnPrev;
    this.#$btnNext = els.btnNext;
    this.#$seekBar = els.seekBar;
    this.#$timeLabel = els.timeLabel;
    this.#$trackList = els.trackList;

    this.#bindFilePicker();
    this.#bindPlayerControls();
  }

  /** Main mono-mix AnalyserNode (available after first file load). */
  get analyser() {
    return this.#analyser;
  }
  /** Left-channel AnalyserNode. */
  get analyserL() {
    return this.#analyserL;
  }
  /** Right-channel AnalyserNode. */
  get analyserR() {
    return this.#analyserR;
  }
  /** Whether playback is currently paused. */
  get paused() {
    return this.#audio.paused;
  }
  /** Whether there is a next track available. */
  get hasNext() {
    return this.#currentIndex < this.#tracks.length - 1;
  }
  /** Whether there is a previous track available. */
  get hasPrev() {
    return this.#currentIndex > 0;
  }

  /** Advance to the next track. */
  next() {
    if (this.hasNext) this.#switchTrack(this.#currentIndex + 1);
  }

  /** Go back to the previous track. */
  prev() {
    if (this.hasPrev) this.#switchTrack(this.#currentIndex - 1);
  }

  // ---- File picker ----

  #bindFilePicker() {
    this.#$fileArea.addEventListener("click", () => this.#$fileInput.click());

    this.#$fileArea.addEventListener("dragover", (e) => {
      e.preventDefault();
      this.#$fileArea.classList.add("dragover");
    });
    this.#$fileArea.addEventListener("dragleave", () => {
      this.#$fileArea.classList.remove("dragover");
    });
    this.#$fileArea.addEventListener("drop", (e) => {
      e.preventDefault();
      this.#$fileArea.classList.remove("dragover");
      if (e.dataTransfer.files.length) this.#loadFiles(e.dataTransfer.files);
    });
    this.#$fileInput.addEventListener("change", () => {
      if (this.#$fileInput.files.length)
        this.#loadFiles(this.#$fileInput.files);
    });
  }

  #loadFiles(fileList) {
    this.#tracks = Array.from(fileList).map((f) => ({
      name: f.name,
      url: URL.createObjectURL(f),
    }));
    this.#renderTrackList();
    this.#switchTrack(0);
  }

  // ---- Track management ----

  #switchTrack(index) {
    this.#currentIndex = index;
    const track = this.#tracks[index];
    this.#audio.src = track.url;
    this.#$fileName.textContent = track.name;
    this.#$btnPlay.disabled = false;
    this.#updateNavButtons();
    this.#highlightTrack();
    this.#ensureAudioContext();
    this.dispatchEvent(new Event("trackchange"));
  }

  #updateNavButtons() {
    this.#$btnPrev.disabled = !this.hasPrev;
    this.#$btnNext.disabled = !this.hasNext;
  }

  #renderTrackList() {
    this.#$trackList.innerHTML = "";
    this.#tracks.forEach((track, i) => {
      const li = document.createElement("li");
      li.textContent = track.name;
      li.addEventListener("click", () => this.#switchTrack(i));
      this.#$trackList.appendChild(li);
    });
  }

  #highlightTrack() {
    const items = this.#$trackList.children;
    for (let i = 0; i < items.length; i++) {
      items[i].classList.toggle("active", i === this.#currentIndex);
    }
  }

  #ensureAudioContext() {
    if (this.#audioCtx) return;

    this.#audioCtx = new AudioContext();

    this.#analyser = this.#audioCtx.createAnalyser();
    this.#analyser.fftSize = 1024;

    this.#sourceNode = this.#audioCtx.createMediaElementSource(this.#audio);
    this.#sourceNode.connect(this.#analyser);
    this.#analyser.connect(this.#audioCtx.destination);

    // Stereo channel split for L/R analysis
    const splitter = this.#audioCtx.createChannelSplitter(2);
    this.#analyserL = this.#audioCtx.createAnalyser();
    this.#analyserL.fftSize = 1024;
    this.#analyserR = this.#audioCtx.createAnalyser();
    this.#analyserR.fftSize = 1024;
    this.#sourceNode.connect(splitter);
    splitter.connect(this.#analyserL, 0);
    splitter.connect(this.#analyserR, 1);
  }

  // ---- Player controls ----

  #bindPlayerControls() {
    this.#$btnPlay.addEventListener("click", () => {
      if (this.#audioCtx?.state === "suspended") this.#audioCtx.resume();

      if (this.#audio.paused) {
        this.#audio.play();
        this.#$btnPlay.innerHTML = "&#9646;&#9646;";
        this.dispatchEvent(new Event("play"));
      } else {
        this.#audio.pause();
        this.#$btnPlay.innerHTML = "&#9654;";
        this.dispatchEvent(new Event("pause"));
      }
    });

    this.#$btnPrev.addEventListener("click", () => this.prev());
    this.#$btnNext.addEventListener("click", () => this.next());

    this.#audio.addEventListener("ended", () => {
      if (this.hasNext) {
        // Auto-advance to next track
        this.next();
        this.#audio.play();
        this.#$btnPlay.innerHTML = "&#9646;&#9646;";
        this.dispatchEvent(new Event("play"));
      } else {
        this.#$btnPlay.innerHTML = "&#9654;";
        this.dispatchEvent(new Event("ended"));
      }
    });

    // Seek bar
    this.#$seekBar.addEventListener("pointerdown", () => {
      this.#seeking = true;
    });
    this.#$seekBar.addEventListener("pointerup", () => {
      this.#seeking = false;
      this.#audio.currentTime =
        parseFloat(this.#$seekBar.value) * this.#audio.duration;
    });
    this.#$seekBar.addEventListener("input", () => {
      if (this.#seeking && this.#audio.duration) {
        this.#audio.currentTime =
          parseFloat(this.#$seekBar.value) * this.#audio.duration;
      }
    });
    this.#audio.addEventListener("timeupdate", () => {
      if (!this.#seeking && this.#audio.duration) {
        this.#$seekBar.value = this.#audio.currentTime / this.#audio.duration;
      }
      this.#$timeLabel.textContent = `${fmt(this.#audio.currentTime)} / ${fmt(this.#audio.duration || 0)}`;
    });
  }
}

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
