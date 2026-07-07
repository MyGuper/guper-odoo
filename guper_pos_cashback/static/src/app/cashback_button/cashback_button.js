/** @odoo-module **/
// Odoo 19: control buttons nao usam registry. Adicionamos o botao ao
// componente ControlButtons via patch e injetamos o markup no template
// point_of_sale.ControlButtons via t-inherit (cashback_button.xml).
import { patch } from "@web/core/utils/patch";
import { ControlButtons } from "@point_of_sale/app/screens/product_screen/control_buttons/control_buttons";
import { makeAwaitable } from "@point_of_sale/app/utils/make_awaitable_dialog";
import { _t } from "@web/core/l10n/translation";
import { GuperPinPopup } from "@guper_pos_cashback/app/pin_popup/pin_popup";

patch(ControlButtons.prototype, {
    async onGuperCashback() {
        const order = this.pos.getOrder();
        const partner = order?.getPartner();
        if (!partner) {
            this.notification.add(_t("Selecione o cliente antes do cashback."), {
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
            this.notification.add("Guper: " + (e.message || _t("erro desconhecido")), {
                type: "danger",
                sticky: true,
            });
            return;
        }

        const redeemable = quote.redeemable_total || 0;
        if (redeemable <= 0) {
            this.notification.add(_t("Sem saldo resgatavel neste pedido."), {
                type: "info",
            });
            return;
        }

        // 2) TODO(guper): popup para o caixa escolher o valor (0..redeemable).
        const amount = redeemable;

        // 3) PIN sempre exigido no resgate.
        const ok = await makeAwaitable(this.dialog, GuperPinPopup, {
            orderUuid: order.uuid,
            call: (path, params) => this._guperCall(path, params),
        });
        if (!ok) {
            this.notification.add(_t("Resgate cancelado (PIN nao validado)."), {
                type: "warning",
            });
            return;
        }

        // 4) Resgate = DESCONTO por linha, usando o valor POR ITEM que o Guper
        //    retorna (redeemable.item[].id/value). Vai no Descuento do CFDI, e o
        //    desconto de cada linha fica igual ao que o Guper calculou.
        const valueByItem = {};
        (quote.redeemable_items || []).forEach((it) => {
            valueByItem[String(it.id)] = it.value; // centavos
        });
        order
            .getOrderlines()
            .filter((l) => l.getQuantity() > 0 && (l.price_unit || 0) >= 0)
            .forEach((l) => {
                const itemId = l.product_id?.default_code || String(l.product_id?.id);
                const value = valueByItem[itemId]; // centavos de desconto do item
                if (!value) {
                    return;
                }
                const subtotal = (l.price_unit || 0) * l.getQuantity();
                if (subtotal <= 0) {
                    return;
                }
                // % que resulta no Descuento = value (base = preco enviado ao Guper).
                let pct = ((value / 100) / subtotal) * 100;
                if (pct > 100) {
                    pct = 100;
                }
                l.setDiscount(pct);
            });
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
                    "erro desconhecido"
            );
        }
        return data.result;
    },
});
