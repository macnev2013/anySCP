import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { hostCardCount, waitForDashboard } from "../helpers/dashboard.js";

describe("smoke", () => {
    beforeEach(async () => {
        await resetApp();
    });

    it("app launches with an empty hosts dashboard", async () => {
        await waitForDashboard();
        expect(await hostCardCount()).to.equal(0);
    });
});
