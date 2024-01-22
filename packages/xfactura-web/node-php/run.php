<?php

require __DIR__ . '/vendor/autoload.php';

use Einvoicing\Invoice;
use Einvoicing\InvoiceLine;
use Einvoicing\Party;
use Einvoicing\Presets;
use Einvoicing\Writers\UblWriter;



$entityBody = file_get_contents('php://input');
$data = json_decode($entityBody);


// Create invoice
$invoice = new Invoice(Presets\CiusRo::class);
$invoice->setNumber($data->metadata->number)
    ->setCurrency($data->metadata->currency)
    ->setIssueDate(new DateTime($data->metadata->issueDate))
    ->setDueDate(new DateTime($data->metadata->dueDate));


// Set seller
$seller = new Party();
$seller
    ->setName($data->seller->name)
    ->setVatNumber($data->seller->vatNumber)
    ->setAddress([$data->seller->address])
    ->setCity($data->seller->city)
    ->setSubdivision($data->seller->subdivision)
    ->setCountry($data->seller->country);
$invoice->setSeller($seller);


// Set buyer
$buyer = new Party();
$buyer
    ->setName($data->buyer->name)
    ->setVatNumber($data->buyer->vatNumber)
    ->setAddress([$data->buyer->address])
    ->setCity($data->buyer->city)
    ->setSubdivision($data->buyer->subdivision)
    ->setCountry($data->buyer->country);
$invoice->setBuyer($buyer);


// Add products
foreach ($data->lines as $line) {
    $invoiceLine = new InvoiceLine();
    $invoiceLine->setName($line->name)
        ->setPrice($line->price)
        ->setVatRate($line->vatRate)
        ->setQuantity($line->quantity);
    $invoice->addLine($invoiceLine);
}



// Export invoice to a UBL document
header('Content-Type: text/xml');
$writer = new UblWriter();
echo $writer->export($invoice);
