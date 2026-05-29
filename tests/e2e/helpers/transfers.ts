// Transfer helpers — drive the SFTP and S3 backend transfer commands via
// the window hooks registered in sftp-store.ts / s3-store.ts.

/** Get the current active SFTP tab's session id (== sftp_session_id). */
export async function activeSftpSessionId(): Promise<string> {
    const tab = await $("[data-tab-type='sftp']");
    await tab.waitForExist({ timeout: 5_000 });
    const id = await tab.getAttribute("data-testid");
    if (!id) throw new Error("active SFTP tab has no data-testid");
    return id.replace(/^tab-/, "");
}

/** Get the current active S3 tab's session id. */
export async function activeS3SessionId(): Promise<string> {
    const tab = await $("[data-tab-type='s3']");
    await tab.waitForExist({ timeout: 5_000 });
    const id = await tab.getAttribute("data-testid");
    if (!id) throw new Error("active S3 tab has no data-testid");
    return id.replace(/^tab-/, "");
}

// ─── SFTP transfer wrappers ──────────────────────────────────────────────────

export async function sftpUpload(
    sessionId: string,
    localPath: string,
    remotePath: string,
): Promise<string> {
    return await browser.execute(
        async (sid: string, lp: string, rp: string) => {
            const fn = (window as unknown as {
                __e2eSftpUpload?: (s: string, l: string, r: string) => Promise<string>;
            }).__e2eSftpUpload;
            if (!fn) throw new Error("__e2eSftpUpload not registered");
            return await fn(sid, lp, rp);
        },
        sessionId,
        localPath,
        remotePath,
    );
}

export async function sftpDownload(
    sessionId: string,
    remotePath: string,
    localPath: string,
): Promise<string> {
    return await browser.execute(
        async (sid: string, rp: string, lp: string) => {
            const fn = (window as unknown as {
                __e2eSftpDownload?: (s: string, r: string, l: string) => Promise<string>;
            }).__e2eSftpDownload;
            if (!fn) throw new Error("__e2eSftpDownload not registered");
            return await fn(sid, rp, lp);
        },
        sessionId,
        remotePath,
        localPath,
    );
}

export async function sftpEnqueueUpload(
    sessionId: string,
    localPaths: string[],
    remoteDir: string,
): Promise<string[]> {
    return await browser.execute(
        async (sid: string, lps: string[], rd: string) => {
            const fn = (window as unknown as {
                __e2eSftpEnqueueUpload?: (s: string, l: string[], r: string) => Promise<string[]>;
            }).__e2eSftpEnqueueUpload;
            if (!fn) throw new Error("__e2eSftpEnqueueUpload not registered");
            return await fn(sid, lps, rd);
        },
        sessionId,
        localPaths,
        remoteDir,
    );
}

export async function sftpCopy(
    sessionId: string,
    sourcePaths: string[],
    targetDir: string,
): Promise<string[]> {
    return await browser.execute(
        async (sid: string, sps: string[], td: string) => {
            const fn = (window as unknown as {
                __e2eSftpCopy?: (s: string, sp: string[], t: string) => Promise<string[]>;
            }).__e2eSftpCopy;
            if (!fn) throw new Error("__e2eSftpCopy not registered");
            return await fn(sid, sps, td);
        },
        sessionId,
        sourcePaths,
        targetDir,
    );
}

export async function sftpMove(
    sessionId: string,
    sourcePaths: string[],
    targetDir: string,
): Promise<string[]> {
    return await browser.execute(
        async (sid: string, sps: string[], td: string) => {
            const fn = (window as unknown as {
                __e2eSftpMove?: (s: string, sp: string[], t: string) => Promise<string[]>;
            }).__e2eSftpMove;
            if (!fn) throw new Error("__e2eSftpMove not registered");
            return await fn(sid, sps, td);
        },
        sessionId,
        sourcePaths,
        targetDir,
    );
}

// ─── SCP transfer wrappers ───────────────────────────────────────────────────
// SCP sessions live in the same tab type ("sftp") and store as SFTP, so
// activeSftpSessionId() returns the SCP session id too.

export async function scpUpload(
    sessionId: string,
    localPath: string,
    remotePath: string,
): Promise<string> {
    return await browser.execute(
        async (sid: string, lp: string, rp: string) => {
            const fn = (window as unknown as {
                __e2eScpUpload?: (s: string, l: string, r: string) => Promise<string>;
            }).__e2eScpUpload;
            if (!fn) throw new Error("__e2eScpUpload not registered");
            return await fn(sid, lp, rp);
        },
        sessionId,
        localPath,
        remotePath,
    );
}

export async function scpDownload(
    sessionId: string,
    remotePath: string,
    localPath: string,
): Promise<string> {
    return await browser.execute(
        async (sid: string, rp: string, lp: string) => {
            const fn = (window as unknown as {
                __e2eScpDownload?: (s: string, r: string, l: string) => Promise<string>;
            }).__e2eScpDownload;
            if (!fn) throw new Error("__e2eScpDownload not registered");
            return await fn(sid, rp, lp);
        },
        sessionId,
        remotePath,
        localPath,
    );
}

// ─── S3 transfer wrappers ────────────────────────────────────────────────────

export async function s3Upload(
    sessionId: string,
    localPath: string,
    key: string,
): Promise<void> {
    await browser.execute(
        async (sid: string, lp: string, k: string) => {
            const fn = (window as unknown as {
                __e2eS3Upload?: (s: string, l: string, k: string) => Promise<void>;
            }).__e2eS3Upload;
            if (!fn) throw new Error("__e2eS3Upload not registered");
            await fn(sid, lp, k);
        },
        sessionId,
        localPath,
        key,
    );
}

export async function s3Download(
    sessionId: string,
    key: string,
    localPath: string,
): Promise<void> {
    await browser.execute(
        async (sid: string, k: string, lp: string) => {
            const fn = (window as unknown as {
                __e2eS3Download?: (s: string, k: string, l: string) => Promise<void>;
            }).__e2eS3Download;
            if (!fn) throw new Error("__e2eS3Download not registered");
            await fn(sid, k, lp);
        },
        sessionId,
        key,
        localPath,
    );
}

export async function s3UploadFiles(
    sessionId: string,
    localPaths: string[],
    prefix: string,
): Promise<number> {
    return await browser.execute(
        async (sid: string, lps: string[], p: string) => {
            const fn = (window as unknown as {
                __e2eS3UploadFiles?: (s: string, l: string[], p: string) => Promise<number>;
            }).__e2eS3UploadFiles;
            if (!fn) throw new Error("__e2eS3UploadFiles not registered");
            return await fn(sid, lps, p);
        },
        sessionId,
        localPaths,
        prefix,
    );
}
