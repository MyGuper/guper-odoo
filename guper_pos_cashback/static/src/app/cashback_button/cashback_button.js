/** @odoo-module **/
// Odoo 19: control buttons nao usam registry. Adicionamos o botao ao
// componente ControlButtons via patch e injetamos o markup no template
// point_of_sale.ControlButtons via t-inherit (cashback_button.xml).
import { patch } from "@web/core/utils/patch";
import { ControlButtons } from "@point_of_sale/app/screens/product_screen/control_buttons/control_buttons";
import { makeAwaitable } from "@point_of_sale/app/utils/make_awaitable_dialog";
import { _t } from "@web/core/l10n/translation";
import { GuperPinPopup } from "@guper_pos_cashback/app/pin_popup/pin_popup";
import { GuperAmountPopup } from "@guper_pos_cashback/app/amount_popup/amount_popup";

patch(ControlButtons.prototype, {
    async onGuperCashback() {
        const order = this.pos.getOrder();
        const partner = order?.getPartner();
        if (!partner) {
            this.notification.add(_t("Seleccione el cliente antes del cashback."), {
                type: "warning",
            });
            return;
        }

        // 1) Cotacao: saldo + maximo resgatavel (reward-by-order server-side).
        let quote;
        try {
            quote = await this._guperCall("/guper/redeem/start", {
                order_uuid: order.uuid,
                config_id: this.pos.config.id,
                partner_id: partner.id,
                items: this._guperItems(order),
            });
        } catch (e) {
            // Mostra o erro real (do backend/Guper), fixo na tela, para depurar.
            this.notification.add("Guper: " + (e.message || _t("error desconocido")), {
                type: "danger",
                sticky: true,
            });
            return;
        }

        const redeemable = quote.redeemable_max || 0; // cap = min(resgatavel, saldo)
        if (redeemable <= 0) {
            this.notification.add(_t("Sin saldo canjeable en este pedido."), {
                type: "info",
            });
            return;
        }

        // 2) PIN sempre exigido no resgate.
        const ok = await makeAwaitable(this.dialog, GuperPinPopup, {
            orderUuid: order.uuid,
            call: (path, params) => this._guperCall(path, params),
        });
        if (!ok) {
            this.notification.add(_t("Canje cancelado (PIN no validado)."), {
                type: "warning",
            });
            return;
        }

        // 3) Valor a resgatar: saldo total + disponivel + campo editavel
        //    (default = resgatavel). Retorna centavos, ou null se cancelar.
        const amount = await makeAwaitable(this.dialog, GuperAmountPopup, {
            balanceCents: quote.balance_total || 0, // saldo total do cliente
            redeemableCents: redeemable, // disponivel nesta compra (cap)
        });
        if (!amount) {
            return;
        }

        // 4) Desconto por linha. A base do % e o total da linha COM imposto,
        //    para o total do pedido cair exatamente o valor resgatado (o IVA
        //    recalcula). grossOf e robusto a variacoes de API da 19.
        const lines = order
            .getOrderlines()
            .filter((l) => l.getQuantity() > 0 && (l.price_unit || 0) >= 0);
        // campo com imposto x quantidade; cai para metodo/liquido se ausente.
        const grossOf = (l) => {
            if (l.price_subtotal_incl != null) {
                return l.price_subtotal_incl;
            }
            if (typeof l.getPriceWithTax === "function") {
                return l.getPriceWithTax();
            }
            return (l.price_unit || 0) * l.getQuantity();
        };
        // desconto ADITIVO: soma ao que a linha ja tiver (nao substitui).
        const addDiscount = (l, pct) =>
            l.setDiscount(Math.min(100, (l.discount || 0) + pct));

        // 4a) Preferencial: valor POR ITEM do Guper (redeemable.item[].id/value),
        //     escalado pelo valor escolhido (fator = amount / resgatavel cheio).
        const rFull = quote.redeemable_full || redeemable;
        const factor = rFull > 0 ? amount / rFull : 0;
        const valueByItem = {};
        (quote.redeemable_items || []).forEach((it) => {
            valueByItem[String(it.id)] = it.value; // centavos
        });

        let applied = false;
        for (const l of lines) {
            const itemId = l.product_id?.default_code || String(l.product_id?.id);
            const value = valueByItem[itemId];
            const gross = grossOf(l);
            if (!value || gross <= 0) {
                continue;
            }
            const pct = (((value * factor) / 100) / gross) * 100;
            addDiscount(l, pct);
            applied = true;
        }

        // 4b) Fallback: Guper nao trouxe quebra por item (ou ids nao casaram)
        //     -> distribui o valor escolhido proporcionalmente nas linhas.
        if (!applied) {
            const grossTotal = lines.reduce((s, l) => s + grossOf(l), 0);
            if (grossTotal > 0) {
                const pct = ((amount / 100) / grossTotal) * 100;
                lines.forEach((l) => addDiscount(l, pct));
            }
        }

        order.guper_redeem_amount = amount;
        this.notification.add(_t("Cashback aplicado."), { type: "success" });
    },

    _guperItems(order) {
        // Exclui a linha de desconto de cashback (preco negativo) sem precisar
        // do id do produto no front.
        return order
            .getOrderlines()
            .filter((l) => l.getQuantity() > 0 && (l.price_unit || 0) >= 0)
            .map((l) => ({
                id: l.product_id?.default_code || String(l.product_id?.id),
                name: l.product_id?.display_name,
                quantity: Math.round(l.getQuantity()),
                price: Math.round((l.price_unit || 0) * 100),
                productId: String(l.product_id?.id),
            }));
    },

    async _guperCall(path, params) {
        const res = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "call", params }),
        });
        const data = await res.json();
        if (data.error) {
            throw new Error(
                data.error.data?.message ||
                    data.error.data?.arguments?.[0] ||
                    data.error.message ||
                    "error desconocido"
            );
        }
        return data.result;
    },
});
